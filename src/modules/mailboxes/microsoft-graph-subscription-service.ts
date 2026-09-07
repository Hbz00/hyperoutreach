import { createHash } from "node:crypto";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mailboxConnections, workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import {
  GraphApiError,
  type MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import {
  graphRetryNotBefore,
  recordGraphRetry,
} from "@/lib/microsoft/graph-retry";

type SubscriptionClient =
  MicrosoftGraphClient | ((lockedDb: AppDatabase) => MicrosoftGraphClient);
const resolveClient = (graph: SubscriptionClient, db: AppDatabase) =>
  typeof graph === "function" ? graph(db) : graph;
const isAbsent = (error: unknown) =>
  error instanceof GraphApiError &&
  (error.status === 404 || error.status === 410);

async function retryGate(db: AppDatabase, mailboxId: string, now: Date) {
  const retryAt = await graphRetryNotBefore(db, mailboxId);
  return retryAt && retryAt > now
    ? ({ ok: false, code: "RETRY_LATER", retryAt } as const)
    : null;
}

async function providerFailure(
  db: AppDatabase,
  mailboxId: string,
  error: unknown,
  now: Date,
) {
  const retryAt = await recordGraphRetry(db, mailboxId, error, now, 60_000);
  return { ok: false, code: "PROVIDER_ERROR", retryAt } as const;
}

const subscriptionSchema = z.object({
  id: z.string().min(1),
  expirationDateTime: z.iso.datetime(),
});
const subscriptionListSchema = z.object({
  "@odata.nextLink": z.string().min(1).max(8192).optional(),
  value: z.array(
    subscriptionSchema.extend({
      resource: z.string(),
      notificationUrl: z.url(),
    }),
  ),
});

const RESOURCE = "me/mailFolders('Inbox')/messages";
const MAX_LIFETIME_MS = 6 * 24 * 60 * 60_000 + 23 * 60 * 60_000;

function clientStateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function ensureGraphSubscription(
  db: AppDatabase,
  graph: SubscriptionClient,
  config: MicrosoftConfig,
  mailboxId: string,
  options: { notificationUrl: string; now?: Date },
) {
  return withActionLocks(db, [actionLockKey.mailbox(mailboxId)], (lockedDb) =>
    ensureGraphSubscriptionLocked(
      lockedDb,
      resolveClient(graph, lockedDb),
      config,
      mailboxId,
      options,
    ),
  );
}

export async function recoverGraphSubscription(
  db: AppDatabase,
  graph: SubscriptionClient,
  config: MicrosoftConfig,
  mailboxId: string,
  expectedSubscriptionId: string | undefined,
  options: { notificationUrl: string; now?: Date },
) {
  return withActionLocks(
    db,
    [actionLockKey.mailbox(mailboxId)],
    async (lockedDb) => {
      const [current] = await lockedDb
        .select()
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, mailboxId))
        .limit(1);
      if (!current || current.provider !== "microsoft_graph") {
        return { ok: false, code: "NOT_FOUND" } as const;
      }
      if (
        current.subscriptionId &&
        expectedSubscriptionId &&
        current.subscriptionId !== expectedSubscriptionId
      ) {
        return { ok: true, disposition: "stale", mailbox: current } as const;
      }
      if (current.status !== "available")
        return { ok: false, code: "UNAVAILABLE" } as const;
      const deferred = await retryGate(
        lockedDb,
        mailboxId,
        options.now ?? new Date(),
      );
      if (deferred) return deferred;
      await lockedDb
        .update(mailboxConnections)
        .set({ subscriptionId: null, subscriptionExpiresAt: null })
        .where(
          expectedSubscriptionId
            ? and(
                eq(mailboxConnections.id, mailboxId),
                or(
                  eq(mailboxConnections.subscriptionId, expectedSubscriptionId),
                  sql`${mailboxConnections.subscriptionId} is null`,
                ),
              )
            : eq(mailboxConnections.id, mailboxId),
        );
      return ensureGraphSubscriptionLocked(
        lockedDb,
        resolveClient(graph, lockedDb),
        config,
        mailboxId,
        options,
      );
    },
  );
}

export async function reauthorizeGraphSubscriptionIfCurrent(
  db: AppDatabase,
  graph: SubscriptionClient,
  mailboxId: string,
  expectedSubscriptionId: string | undefined,
  now: Date,
) {
  return withActionLocks(
    db,
    [actionLockKey.mailbox(mailboxId)],
    async (lockedDb) => {
      const [current] = await lockedDb
        .select()
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, mailboxId))
        .limit(1);
      if (!current || current.provider !== "microsoft_graph")
        return { ok: false, code: "NOT_FOUND" } as const;
      if (current.status !== "available")
        return { ok: false, code: "UNAVAILABLE" } as const;
      const deferred = await retryGate(lockedDb, mailboxId, now);
      if (deferred) return deferred;
      if (!expectedSubscriptionId)
        return { ok: true, disposition: "stale" } as const;
      if (!current.subscriptionId)
        return { ok: true, disposition: "missing" } as const;
      if (current.subscriptionId !== expectedSubscriptionId)
        return { ok: true, disposition: "stale" } as const;
      try {
        const response = subscriptionSchema.parse(
          await resolveClient(graph, lockedDb).patch<unknown>(
            `/subscriptions/${encodeURIComponent(expectedSubscriptionId)}`,
            {
              expirationDateTime: new Date(
                now.getTime() + MAX_LIFETIME_MS,
              ).toISOString(),
            },
          ),
        );
        if (response.id !== expectedSubscriptionId)
          throw new Error("Graph subscription identity changed");
        const [updated] = await lockedDb
          .update(mailboxConnections)
          .set({ subscriptionExpiresAt: new Date(response.expirationDateTime) })
          .where(
            and(
              eq(mailboxConnections.id, mailboxId),
              eq(mailboxConnections.status, "available"),
              eq(mailboxConnections.subscriptionId, expectedSubscriptionId),
            ),
          )
          .returning({ id: mailboxConnections.id });
        return {
          ok: true,
          disposition: updated ? "reauthorized" : "stale",
        } as const;
      } catch (error) {
        if (isAbsent(error)) {
          const [cleared] = await lockedDb
            .update(mailboxConnections)
            .set({ subscriptionId: null, subscriptionExpiresAt: null })
            .where(
              and(
                eq(mailboxConnections.id, mailboxId),
                eq(mailboxConnections.subscriptionId, expectedSubscriptionId),
              ),
            )
            .returning({ id: mailboxConnections.id });
          return {
            ok: true,
            disposition: cleared ? "missing" : "stale",
          } as const;
        }
        return providerFailure(lockedDb, mailboxId, error, now);
      }
    },
  );
}

async function ensureGraphSubscriptionLocked(
  db: AppDatabase,
  graph: MicrosoftGraphClient,
  config: MicrosoftConfig,
  mailboxId: string,
  options: { notificationUrl: string; now?: Date },
) {
  const notificationUrl = z.url().parse(options.notificationUrl);
  if (!notificationUrl.startsWith("https://")) {
    return { ok: false, code: "INVALID_NOTIFICATION_URL" } as const;
  }
  const now = options.now ?? new Date();
  const expectedClientStateHash = clientStateHash(config.webhookClientState);
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (!mailbox || mailbox.provider !== "microsoft_graph") {
    return { ok: false, code: "NOT_FOUND" } as const;
  }
  if (mailbox.status !== "available")
    return { ok: false, code: "UNAVAILABLE" } as const;
  const deferred = await retryGate(db, mailboxId, now);
  if (deferred) return deferred;
  const owner = and(
    eq(mailboxConnections.id, mailbox.id),
    eq(mailboxConnections.status, "available"),
    mailbox.subscriptionId
      ? eq(mailboxConnections.subscriptionId, mailbox.subscriptionId)
      : isNull(mailboxConnections.subscriptionId),
  );
  const clientStateChanged =
    mailbox.subscriptionClientStateHash !== null &&
    mailbox.subscriptionClientStateHash !== expectedClientStateHash;
  if (
    mailbox.subscriptionId &&
    mailbox.subscriptionExpiresAt &&
    mailbox.subscriptionExpiresAt > now &&
    mailbox.subscriptionClientStateHash === expectedClientStateHash &&
    mailbox.subscriptionResource?.toLowerCase() === RESOURCE.toLowerCase()
  ) {
    return { ok: true, disposition: "existing", mailbox } as const;
  }
  try {
    if (mailbox.subscriptionId) {
      try {
        await graph.delete(
          `/subscriptions/${encodeURIComponent(mailbox.subscriptionId)}`,
        );
      } catch (error) {
        // Only confirmed absence permits the next provider operation.
        if (!isAbsent(error)) throw error;
      }
    }
    const matchingRemotes: z.infer<typeof subscriptionListSchema>["value"] = [];
    const visited = new Set<string>();
    let next: string | undefined = "/subscriptions";
    while (next) {
      if (visited.has(next) || visited.size >= 100) {
        throw new Error("Microsoft subscription continuation limit exceeded");
      }
      visited.add(next);
      const page = subscriptionListSchema.parse(await graph.get<unknown>(next));
      matchingRemotes.push(
        ...page.value.filter(
          (subscription) =>
            subscription.resource.toLowerCase() === RESOURCE.toLowerCase() &&
            subscription.notificationUrl === notificationUrl &&
            new Date(subscription.expirationDateTime) > now,
        ),
      );
      next = page["@odata.nextLink"];
    }
    if (clientStateChanged) {
      for (const subscription of matchingRemotes) {
        try {
          await graph.delete(
            `/subscriptions/${encodeURIComponent(subscription.id)}`,
          );
        } catch (error) {
          if (!isAbsent(error)) throw error;
        }
      }
    }
    const remote = clientStateChanged ? undefined : matchingRemotes[0];
    if (remote) {
      const [updated] = await db
        .update(mailboxConnections)
        .set({
          subscriptionId: remote.id,
          subscriptionExpiresAt: new Date(remote.expirationDateTime),
          subscriptionClientStateHash: clientStateHash(
            config.webhookClientState,
          ),
          subscriptionResource: RESOURCE,
          lastSyncedAt:
            mailbox.lastSyncedAt ?? new Date(now.getTime() - 5 * 60_000),
        })
        .where(owner)
        .returning();
      if (!updated) return { ok: false, code: "OWNERSHIP_CHANGED" } as const;
      return {
        ok: true,
        disposition: "recovered",
        mailbox: updated!,
      } as const;
    }
    const response = subscriptionSchema.parse(
      await graph.post<unknown>("/subscriptions", {
        changeType: "created,updated",
        notificationUrl,
        lifecycleNotificationUrl: notificationUrl,
        resource: RESOURCE,
        expirationDateTime: new Date(
          now.getTime() + MAX_LIFETIME_MS,
        ).toISOString(),
        clientState: config.webhookClientState,
        latestSupportedTlsVersion: "v1_2",
      }),
    );
    const [updated] = await db
      .update(mailboxConnections)
      .set({
        subscriptionId: response.id,
        subscriptionExpiresAt: new Date(response.expirationDateTime),
        subscriptionClientStateHash: clientStateHash(config.webhookClientState),
        subscriptionResource: RESOURCE,
        lastSyncedAt:
          mailbox.lastSyncedAt ?? new Date(now.getTime() - 5 * 60_000),
      })
      .where(owner)
      .returning();
    if (!updated) return { ok: false, code: "OWNERSHIP_CHANGED" } as const;
    return { ok: true, disposition: "created", mailbox: updated } as const;
  } catch (error) {
    return providerFailure(db, mailboxId, error, now);
  }
}

export async function renewDueGraphSubscriptions(
  db: AppDatabase,
  graphForMailbox: (
    mailboxId: string,
    mailboxDb?: AppDatabase,
  ) => MicrosoftGraphClient,
  options: { now?: Date; renewBeforeMs?: number } = {},
) {
  const now = options.now ?? new Date();
  const threshold = new Date(
    now.getTime() + (options.renewBeforeMs ?? 24 * 60 * 60_000),
  );
  const due = await db
    .select()
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.provider, "microsoft_graph"),
        eq(mailboxConnections.status, "available"),
        lte(mailboxConnections.subscriptionExpiresAt, threshold),
      ),
    );
  let renewed = 0;
  let failed = 0;
  for (const candidate of due) {
    const outcome = await withActionLocks(
      db,
      [actionLockKey.mailbox(candidate.id)],
      async (lockedDb) => {
        const [current] = await lockedDb
          .select()
          .from(mailboxConnections)
          .where(eq(mailboxConnections.id, candidate.id))
          .limit(1);
        if (
          !current ||
          current.status !== "available" ||
          !current.subscriptionId ||
          current.subscriptionId !== candidate.subscriptionId ||
          !current.subscriptionExpiresAt ||
          current.subscriptionExpiresAt > threshold
        )
          return "skipped";
        if (await retryGate(lockedDb, current.id, now)) return "deferred";
        const owner = and(
          eq(mailboxConnections.id, current.id),
          eq(mailboxConnections.status, "available"),
          eq(mailboxConnections.subscriptionId, current.subscriptionId),
        );
        try {
          const response = subscriptionSchema.parse(
            await graphForMailbox(current.id, lockedDb).patch<unknown>(
              `/subscriptions/${encodeURIComponent(current.subscriptionId)}`,
              {
                expirationDateTime: new Date(
                  now.getTime() + MAX_LIFETIME_MS,
                ).toISOString(),
              },
            ),
          );
          if (response.id !== current.subscriptionId)
            throw new Error("Graph subscription identity changed");
          const [updated] = await lockedDb
            .update(mailboxConnections)
            .set({
              subscriptionExpiresAt: new Date(response.expirationDateTime),
            })
            .where(owner)
            .returning({ id: mailboxConnections.id });
          return updated ? "renewed" : "skipped";
        } catch (error) {
          if (isAbsent(error)) {
            await lockedDb.transaction(async (tx) => {
              const [cleared] = await tx
                .update(mailboxConnections)
                .set({ subscriptionId: null, subscriptionExpiresAt: null })
                .where(owner)
                .returning({ id: mailboxConnections.id });
              if (!cleared) return;
              await tx
                .insert(workflowEvents)
                .values({
                  entityType: "mailbox",
                  entityId: current.id,
                  event: "graph.lifecycle.subscriptionRemoved",
                  workflowName: "graph_lifecycle_reconciliation",
                  idempotencyKey: `graph:renewal-recovery:${current.id}:${now.toISOString()}`,
                  status: "scheduled",
                  scheduledAt: now,
                  error:
                    "Microsoft Graph subscription renewal requires recreation",
                  payload: {
                    lifecycleEvent: "subscriptionRemoved",
                    subscriptionId: current.subscriptionId,
                  },
                })
                .onConflictDoNothing();
            });
          } else {
            await recordGraphRetry(lockedDb, current.id, error, now, 60_000);
          }
          return "failed";
        }
      },
    );
    if (outcome === "renewed") renewed++;
    else if (outcome === "failed") failed++;
  }
  return { renewed, failed };
}

export async function deleteGraphSubscription(
  db: AppDatabase,
  graph: MicrosoftGraphClient,
  mailboxId: string,
) {
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (!mailbox?.subscriptionId)
    return { ok: true, disposition: "absent" } as const;
  try {
    await graph.delete(
      `/subscriptions/${encodeURIComponent(mailbox.subscriptionId)}`,
    );
    await db
      .update(mailboxConnections)
      .set({
        subscriptionId: null,
        subscriptionExpiresAt: null,
        subscriptionClientStateHash: null,
        subscriptionResource: null,
      })
      .where(eq(mailboxConnections.id, mailbox.id));
    return { ok: true, disposition: "deleted" } as const;
  } catch {
    return { ok: false, code: "PROVIDER_ERROR" } as const;
  }
}
