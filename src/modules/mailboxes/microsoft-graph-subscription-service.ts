import { createHash } from "node:crypto";

import { and, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mailboxConnections, workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import type { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";

const subscriptionSchema = z.object({
  id: z.string().min(1),
  expirationDateTime: z.iso.datetime(),
});
const subscriptionListSchema = z.object({
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
  graph: MicrosoftGraphClient,
  config: MicrosoftConfig,
  mailboxId: string,
  options: { notificationUrl: string; now?: Date },
) {
  return withActionLocks(db, [actionLockKey.mailbox(mailboxId)], (lockedDb) =>
    ensureGraphSubscriptionLocked(lockedDb, graph, config, mailboxId, options),
  );
}

export async function recoverGraphSubscription(
  db: AppDatabase,
  graph: MicrosoftGraphClient,
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
        graph,
        config,
        mailboxId,
        options,
      );
    },
  );
}

export async function reauthorizeGraphSubscriptionIfCurrent(
  db: AppDatabase,
  graph: MicrosoftGraphClient,
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
      if (!current || current.provider !== "microsoft_graph") {
        return { ok: false, code: "NOT_FOUND" } as const;
      }
      if (
        !expectedSubscriptionId ||
        current.subscriptionId !== expectedSubscriptionId
      ) {
        return { ok: true, disposition: "stale" } as const;
      }
      const response = subscriptionSchema.parse(
        await graph.patch<unknown>(
          `/subscriptions/${encodeURIComponent(expectedSubscriptionId)}`,
          {
            expirationDateTime: new Date(
              now.getTime() + MAX_LIFETIME_MS,
            ).toISOString(),
          },
        ),
      );
      await lockedDb
        .update(mailboxConnections)
        .set({ subscriptionExpiresAt: new Date(response.expirationDateTime) })
        .where(
          and(
            eq(mailboxConnections.id, mailboxId),
            eq(mailboxConnections.subscriptionId, expectedSubscriptionId),
          ),
        );
      return { ok: true, disposition: "reauthorized" } as const;
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
      } catch {
        // Listing below recovers or replaces this subscription safely.
      }
    }
    const remoteSubscriptions = subscriptionListSchema.parse(
      await graph.get<unknown>("/subscriptions"),
    );
    const matchingRemotes = remoteSubscriptions.value.filter(
      (subscription) =>
        subscription.resource.toLowerCase() === RESOURCE.toLowerCase() &&
        subscription.notificationUrl === notificationUrl &&
        new Date(subscription.expirationDateTime) > now,
    );
    if (clientStateChanged) {
      await Promise.allSettled(
        matchingRemotes.map((subscription) =>
          graph.delete(`/subscriptions/${encodeURIComponent(subscription.id)}`),
        ),
      );
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
        .where(eq(mailboxConnections.id, mailbox.id))
        .returning();
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
      .where(eq(mailboxConnections.id, mailbox.id))
      .returning();
    return { ok: true, disposition: "created", mailbox: updated! } as const;
  } catch {
    return { ok: false, code: "PROVIDER_ERROR" } as const;
  }
}

export async function renewDueGraphSubscriptions(
  db: AppDatabase,
  graphForMailbox: (mailboxId: string) => MicrosoftGraphClient,
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
  for (const mailbox of due) {
    if (!mailbox.subscriptionId) continue;
    try {
      const response = subscriptionSchema.parse(
        await graphForMailbox(mailbox.id).patch<unknown>(
          `/subscriptions/${encodeURIComponent(mailbox.subscriptionId)}`,
          {
            expirationDateTime: new Date(
              now.getTime() + MAX_LIFETIME_MS,
            ).toISOString(),
          },
        ),
      );
      await db
        .update(mailboxConnections)
        .set({ subscriptionExpiresAt: new Date(response.expirationDateTime) })
        .where(eq(mailboxConnections.id, mailbox.id));
      renewed += 1;
    } catch {
      failed += 1;
      await withActionLocks(
        db,
        [actionLockKey.mailbox(mailbox.id)],
        async (lockedDb) => {
          const [cleared] = await lockedDb
            .update(mailboxConnections)
            .set({ subscriptionId: null, subscriptionExpiresAt: null })
            .where(
              and(
                eq(mailboxConnections.id, mailbox.id),
                eq(mailboxConnections.subscriptionId, mailbox.subscriptionId!),
              ),
            )
            .returning({ id: mailboxConnections.id });
          if (!cleared) return;
          await lockedDb.insert(workflowEvents).values({
            entityType: "mailbox",
            entityId: mailbox.id,
            event: "graph.lifecycle.subscriptionRemoved",
            workflowName: "graph_lifecycle_reconciliation",
            idempotencyKey: `graph:renewal-recovery:${mailbox.id}:${now.toISOString()}`,
            status: "scheduled",
            scheduledAt: now,
            error: "Microsoft Graph subscription renewal requires recreation",
            payload: {
              lifecycleEvent: "subscriptionRemoved",
              subscriptionId: mailbox.subscriptionId,
            },
          });
        },
      );
    }
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
