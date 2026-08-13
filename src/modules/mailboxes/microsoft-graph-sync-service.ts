import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  graphNotificationReceipts,
  mailboxConnections,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import {
  GraphApiError,
  type MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import { graphMessageToInbound } from "@/modules/mailboxes/microsoft-graph-message";
import { createMicrosoftGraphInboundSource } from "@/modules/mailboxes/microsoft-graph-inbound-source";
import {
  graphDeltaCursorEvents,
  graphDeltaHealthOptions,
} from "@/modules/mailboxes/microsoft-graph-inbound-naming";
import {
  createCountingIngest,
  createInboundCursorWriter,
  reconcileInboundMailbox,
  withInboundReconciliationHealth,
} from "@/modules/mailboxes/inbound-reconciliation";
import {
  parseGraphNotifications,
  validateWebhookClientState,
} from "@/modules/mailboxes/microsoft-graph-webhook";
import { ingestMatchedInboundMessage } from "@/modules/replies/inbound-service";
import type { ReplyClassifier } from "@/modules/replies/reply-classifier";
import {
  ensureGraphSubscription,
  reauthorizeGraphSubscriptionIfCurrent,
  recoverGraphSubscription,
  renewDueGraphSubscriptions,
} from "@/modules/mailboxes/microsoft-graph-subscription-service";

function notificationKey(input: {
  notificationId?: string;
  subscriptionId: string;
  changeType: string;
  resourceId: string;
}): string {
  return createHash("sha256")
    .update(
      input.notificationId ??
        `${input.subscriptionId}\0${input.changeType}\0${input.resourceId}`,
    )
    .digest("hex");
}

function messagePath(messageId: string): string {
  return `/me/messages/${encodeURIComponent(messageId)}?$select=id,internetMessageId,conversationId,subject,receivedDateTime,from,toRecipients,body,internetMessageHeaders`;
}

export async function processGraphWebhook(
  db: AppDatabase,
  graphForMailbox: (mailboxId: string) => MicrosoftGraphClient,
  classifier: ReplyClassifier,
  config: MicrosoftConfig,
  rawPayload: unknown,
  options: { notificationUrl?: string } = {},
) {
  const staged = await stageGraphWebhook(db, config, rawPayload);
  await reconcilePendingGraphNotifications(db, graphForMailbox, classifier);
  await reconcilePendingGraphLifecycleEvents(
    db,
    graphForMailbox,
    classifier,
    config,
    options,
  );
  return staged;
}

export async function runMicrosoftGraphMaintenance(
  db: AppDatabase,
  graphForMailbox: (mailboxId: string) => MicrosoftGraphClient,
  classifier: ReplyClassifier,
  config: MicrosoftConfig,
  options: { notificationUrl: string; now?: Date },
) {
  const now = options.now ?? new Date();
  const mailboxes = await db
    .select({ id: mailboxConnections.id })
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.provider, "microsoft_graph"),
        eq(mailboxConnections.status, "available"),
      ),
    );
  let subscriptionsEnsured = 0;
  let subscriptionsFailed = 0;
  for (const mailbox of mailboxes) {
    const subscription = await ensureGraphSubscription(
      db,
      graphForMailbox(mailbox.id),
      config,
      mailbox.id,
      { notificationUrl: options.notificationUrl, now },
    );
    if (subscription.ok) subscriptionsEnsured += 1;
    else subscriptionsFailed += 1;
  }
  const renewal = await renewDueGraphSubscriptions(db, graphForMailbox, {
    now,
  });
  const lifecycle = await reconcilePendingGraphLifecycleEvents(
    db,
    graphForMailbox,
    classifier,
    config,
    { notificationUrl: options.notificationUrl, now },
  );
  const notifications = await reconcilePendingGraphNotifications(
    db,
    graphForMailbox,
    classifier,
    { now },
  );
  let deltaSynced = 0;
  let deltaFailed = 0;
  for (const mailbox of mailboxes) {
    try {
      await reconcileGraphDelta(
        db,
        graphForMailbox(mailbox.id),
        classifier,
        mailbox.id,
      );
      deltaSynced += 1;
    } catch {
      deltaFailed += 1;
    }
  }
  return {
    subscriptionsEnsured,
    subscriptionsFailed,
    renewal,
    lifecycle,
    notifications,
    deltaSynced,
    deltaFailed,
  };
}

export async function stageGraphWebhook(
  db: AppDatabase,
  config: MicrosoftConfig,
  rawPayload: unknown,
) {
  let notifications;
  try {
    notifications = parseGraphNotifications(rawPayload);
  } catch {
    return { accepted: 0, duplicates: 0, rejected: 1 };
  }
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const notification of notifications) {
    if (
      !validateWebhookClientState(
        notification.clientState,
        config.webhookClientState,
      )
    ) {
      rejected += 1;
      continue;
    }
    const [mailbox] = await db
      .select()
      .from(mailboxConnections)
      .where(
        and(
          eq(mailboxConnections.provider, "microsoft_graph"),
          eq(mailboxConnections.subscriptionId, notification.subscriptionId),
        ),
      )
      .limit(1);
    if (!mailbox || mailbox.status !== "available") {
      rejected += 1;
      continue;
    }
    const staged = await withActionLocks(
      db,
      [actionLockKey.mailbox(mailbox.id)],
      async (lockedDb) => {
        const [current] = await lockedDb
          .select({ id: mailboxConnections.id })
          .from(mailboxConnections)
          .where(
            and(
              eq(mailboxConnections.id, mailbox.id),
              eq(
                mailboxConnections.subscriptionId,
                notification.subscriptionId,
              ),
              eq(mailboxConnections.status, "available"),
            ),
          )
          .limit(1);
        if (!current) return "rejected" as const;
        if ("lifecycleEvent" in notification) {
          const lifecycleKey = `graph:lifecycle:${notification.id ?? randomUUID()}`;
          const [created] = await lockedDb
            .insert(workflowEvents)
            .values({
              entityType: "mailbox",
              entityId: mailbox.id,
              event: `graph.lifecycle.${notification.lifecycleEvent}`,
              workflowName: "graph_lifecycle_reconciliation",
              idempotencyKey: lifecycleKey,
              status: "scheduled",
              scheduledAt: new Date(),
              payload: {
                subscriptionId: notification.subscriptionId,
                lifecycleEvent: notification.lifecycleEvent,
              },
            })
            .onConflictDoNothing()
            .returning({ id: workflowEvents.id });
          return created ? ("accepted" as const) : ("duplicate" as const);
        }
        const deduplicationKey = notificationKey({
          notificationId: notification.id,
          subscriptionId: notification.subscriptionId,
          changeType: notification.changeType,
          resourceId: notification.resourceData.id,
        });
        const [created] = await lockedDb
          .insert(graphNotificationReceipts)
          .values({
            mailboxId: mailbox.id,
            deduplicationKey,
            subscriptionId: notification.subscriptionId,
            resourceId: notification.resourceData.id,
            changeType: notification.changeType,
          })
          .onConflictDoNothing()
          .returning({ id: graphNotificationReceipts.id });
        return created ? ("accepted" as const) : ("duplicate" as const);
      },
    );
    if (staged === "accepted") accepted += 1;
    else if (staged === "duplicate") duplicates += 1;
    else rejected += 1;
  }
  return { accepted, duplicates, rejected };
}

export async function reconcilePendingGraphNotifications(
  db: AppDatabase,
  graphForMailbox: (mailboxId: string) => MicrosoftGraphClient,
  classifier: ReplyClassifier,
  options: { now?: Date; limit?: number; claimTtlMs?: number } = {},
) {
  const now = options.now ?? new Date();
  const staleBefore = new Date(
    now.getTime() - (options.claimTtlMs ?? 5 * 60_000),
  );
  const candidates = await db
    .select()
    .from(graphNotificationReceipts)
    .where(
      and(
        isNull(graphNotificationReceipts.processedAt),
        or(
          isNull(graphNotificationReceipts.nextAttemptAt),
          lte(graphNotificationReceipts.nextAttemptAt, now),
        ),
        or(
          isNull(graphNotificationReceipts.claimedAt),
          lt(graphNotificationReceipts.claimedAt, staleBefore),
        ),
      ),
    )
    .orderBy(
      sql`${graphNotificationReceipts.nextAttemptAt} asc nulls first`,
      asc(graphNotificationReceipts.receivedAt),
    )
    .limit(options.limit ?? 100);
  let processed = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimId = randomUUID();
    const [claimed] = await db
      .update(graphNotificationReceipts)
      .set({
        claimId,
        claimedAt: now,
        attemptCount: candidate.attemptCount + 1,
      })
      .where(
        and(
          eq(graphNotificationReceipts.id, candidate.id),
          isNull(graphNotificationReceipts.processedAt),
          or(
            isNull(graphNotificationReceipts.nextAttemptAt),
            lte(graphNotificationReceipts.nextAttemptAt, now),
          ),
          or(
            isNull(graphNotificationReceipts.claimedAt),
            lt(graphNotificationReceipts.claimedAt, staleBefore),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      let terminalNote: string | null = null;
      if (claimed.changeType !== "deleted") {
        let raw: unknown;
        try {
          raw = await graphForMailbox(claimed.mailboxId).get<unknown>(
            messagePath(claimed.resourceId),
          );
        } catch (error) {
          if (error instanceof GraphApiError && error.status === 404) {
            await reconcileGraphDelta(
              db,
              graphForMailbox(claimed.mailboxId),
              classifier,
              claimed.mailboxId,
            );
            terminalNote = "Graph message unavailable; delta reconciled";
          } else {
            throw error;
          }
        }
        if (raw !== undefined) {
          let inbound;
          try {
            inbound = graphMessageToInbound(
              claimed.mailboxId,
              claimed.deduplicationKey,
              raw,
            );
          } catch {
            terminalNote = "Graph message quarantined as invalid";
            await db
              .insert(workflowEvents)
              .values({
                entityType: "mailbox",
                entityId: claimed.mailboxId,
                event: "graph.message_quarantined",
                workflowName: "graph_notification_reconciliation",
                idempotencyKey: `graph:quarantine:${claimed.deduplicationKey}`,
                status: "scheduled",
                scheduledAt: now,
                payload: {
                  receiptId: claimed.id,
                  resourceId: claimed.resourceId,
                  reason: "invalid_graph_message_shape",
                },
              })
              .onConflictDoNothing();
          }
          if (inbound) {
            const result = await ingestMatchedInboundMessage(
              db,
              classifier,
              inbound,
            );
            if (
              !result.ok &&
              (result.code === "DATABASE_ERROR" ||
                result.code === "INVALID_INPUT")
            ) {
              throw new Error("Inbound persistence not completed");
            } else if (!result.ok) {
              terminalNote = `Inbound is durable with ${result.code.toLowerCase()} reconciliation pending`;
            }
          }
        }
      }
      await db
        .update(graphNotificationReceipts)
        .set({
          processedAt: new Date(),
          claimId: null,
          claimedAt: null,
          nextAttemptAt: null,
          requiresReview:
            terminalNote === "Graph message quarantined as invalid",
          error: terminalNote,
        })
        .where(
          and(
            eq(graphNotificationReceipts.id, claimed.id),
            eq(graphNotificationReceipts.claimId, claimId),
          ),
        );
      processed += 1;
    } catch {
      const retryDelayMs = Math.min(
        60 * 60_000,
        1_000 * 2 ** Math.min(claimed.attemptCount, 12),
      );
      await db
        .update(graphNotificationReceipts)
        .set({
          claimId: null,
          claimedAt: null,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs),
          error: "Graph notification processing failed",
        })
        .where(
          and(
            eq(graphNotificationReceipts.id, claimed.id),
            eq(graphNotificationReceipts.claimId, claimId),
          ),
        );
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function resolveGraphNotificationQuarantine(
  db: AppDatabase,
  receiptId: string,
  now = new Date(),
) {
  const [resolved] = await db
    .update(graphNotificationReceipts)
    .set({ requiresReview: false, reviewResolvedAt: now })
    .where(
      and(
        eq(graphNotificationReceipts.id, z.uuid().parse(receiptId)),
        eq(graphNotificationReceipts.requiresReview, true),
        isNull(graphNotificationReceipts.reviewResolvedAt),
      ),
    )
    .returning();
  return resolved
    ? ({ ok: true, receipt: resolved } as const)
    : ({ ok: false, code: "NOT_FOUND" } as const);
}

export async function reconcilePendingGraphLifecycleEvents(
  db: AppDatabase,
  graphForMailbox: (mailboxId: string) => MicrosoftGraphClient,
  classifier: ReplyClassifier,
  config: MicrosoftConfig,
  options: { notificationUrl?: string; now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 5 * 60_000);
  const events = await db
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowName, "graph_lifecycle_reconciliation"),
        or(
          isNull(workflowEvents.scheduledAt),
          lte(workflowEvents.scheduledAt, now),
        ),
        or(
          inArray(workflowEvents.status, ["scheduled", "failed"]),
          and(
            eq(workflowEvents.status, "started"),
            lt(workflowEvents.startedAt, staleBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(workflowEvents.createdAt))
    .limit(options.limit ?? 100);
  let processed = 0;
  let failed = 0;
  for (const event of events) {
    const claimId = randomUUID();
    const [claimed] = await db
      .update(workflowEvents)
      .set({
        status: "started",
        runId: claimId,
        startedAt: now,
        completedAt: null,
        attempt: event.attempt + 1,
      })
      .where(
        and(
          eq(workflowEvents.id, event.id),
          or(
            inArray(workflowEvents.status, ["scheduled", "failed"]),
            and(
              eq(workflowEvents.status, "started"),
              lt(workflowEvents.startedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;
    const payload = claimed.payload as {
      lifecycleEvent?: string;
      subscriptionId?: string;
    };
    try {
      const graph = graphForMailbox(claimed.entityId);
      if (payload.lifecycleEvent === "reauthorizationRequired") {
        const reauthorization = await reauthorizeGraphSubscriptionIfCurrent(
          db,
          graph,
          claimed.entityId,
          payload.subscriptionId,
          now,
        );
        if (!reauthorization.ok) {
          throw new Error("Subscription reauthorization failed");
        }
        await reconcileGraphDelta(db, graph, classifier, claimed.entityId);
      } else {
        if (payload.lifecycleEvent === "subscriptionRemoved") {
          if (!options.notificationUrl) {
            throw new Error("Graph notification URL is required for recovery");
          }
          const subscription = await recoverGraphSubscription(
            db,
            graph,
            config,
            claimed.entityId,
            payload.subscriptionId,
            { notificationUrl: options.notificationUrl, now },
          );
          if (!subscription.ok) throw new Error("Subscription recovery failed");
        }
        await reconcileGraphDelta(db, graph, classifier, claimed.entityId);
      }
      await db
        .update(workflowEvents)
        .set({ status: "succeeded", completedAt: new Date(), error: null })
        .where(
          and(
            eq(workflowEvents.id, claimed.id),
            eq(workflowEvents.runId, claimId),
          ),
        );
      processed += 1;
    } catch {
      await db
        .update(workflowEvents)
        .set({
          status: "failed",
          completedAt: new Date(),
          scheduledAt: new Date(
            now.getTime() +
              Math.min(60 * 60_000, 1_000 * 2 ** Math.min(claimed.attempt, 12)),
          ),
          error: "Graph lifecycle recovery failed",
        })
        .where(
          and(
            eq(workflowEvents.id, claimed.id),
            eq(workflowEvents.runId, claimId),
          ),
        );
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function reconcileGraphDelta(
  db: AppDatabase,
  graph: MicrosoftGraphClient,
  classifier: ReplyClassifier,
  mailboxId: string,
) {
  return withInboundReconciliationHealth(
    db,
    mailboxId,
    // Graph predates the shared naming and keeps its own keys and events: the
    // send gate reads the `graph_delta_health` workflow and operators watch
    // these event names. Sourced from microsoft-graph-inbound-naming.ts so
    // this literal set has exactly one place of truth, shared with the
    // generic "reconcile-inbound-mailbox" task's registry entry.
    graphDeltaHealthOptions(mailboxId),
    async () => {
      const roundStartedAt = new Date();
      const [mailbox] = await db
        .select()
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, mailboxId))
        .limit(1);
      if (!mailbox || mailbox.provider !== "microsoft_graph") {
        throw new Error("Microsoft mailbox not found");
      }
      if (!mailbox.lastSyncedAt && !mailbox.syncCursor) {
        throw new Error("Microsoft mailbox sync anchor is missing");
      }
      // The audit payload needs the count while the round is still running,
      // because `saveCursor` is only told about the cursor.
      const counted = createCountingIngest((message) =>
        ingestMatchedInboundMessage(db, classifier, message),
      );
      const result = await reconcileInboundMailbox(
        {
          source: createMicrosoftGraphInboundSource(graph, {
            id: mailbox.id,
            since: mailbox.lastSyncedAt ?? new Date(0),
          }),
          mailboxId: mailbox.id,
        },
        {
          loadCursor: async () => mailbox.syncCursor,
          saveCursor: createInboundCursorWriter(db, {
            events: graphDeltaCursorEvents(),
            startedAt: roundStartedAt,
            payload: (round) => ({
              processed: counted.processed(),
              rebaselined: round.rebaselined,
            }),
          }),
          ingest: counted.ingest,
        },
      );
      return { processed: result.processed, rebaselined: result.rebaselined };
    },
  );
}
