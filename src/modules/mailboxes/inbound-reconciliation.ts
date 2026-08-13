import { eq } from "drizzle-orm";

import { mailboxConnections, workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import type { InboundMailSource } from "@/modules/mailboxes/inbound-source";
import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

/**
 * A round persists the anchor slightly in the past so a provider that
 * rebaselines from it cannot skip a message that arrived while the round ran.
 */
export const INBOUND_ANCHOR_SKEW_MS = 5 * 60_000;

export type InboundIngestOutcome = {
  ok: boolean;
  disposition?: string;
  code?: string;
};

export type InboundReconciliationDeps = {
  loadCursor: (mailboxId: string) => Promise<string | null>;
  saveCursor: (
    mailboxId: string,
    cursor: string,
    rebaselined: boolean,
  ) => Promise<void>;
  ingest: (message: unknown) => Promise<InboundIngestOutcome>;
};

/**
 * A message counts as processed unless the round found it already ingested.
 * Single source of the rule: the round and any external tally must agree.
 */
function isProcessedIngest(outcome: InboundIngestOutcome): boolean {
  return Boolean(outcome.ok && outcome.disposition !== "existing");
}

/**
 * Wraps an `ingest` dependency with a running tally, for a caller that needs
 * the count before the round returns — writing it into the audit payload, for
 * instance, since `saveCursor` is only told about the cursor.
 */
export function createCountingIngest(
  ingest: InboundReconciliationDeps["ingest"],
): {
  ingest: InboundReconciliationDeps["ingest"];
  processed: () => number;
} {
  let processed = 0;
  return {
    ingest: async (message) => {
      const outcome = await ingest(message);
      if (isProcessedIngest(outcome)) processed += 1;
      return outcome;
    },
    processed: () => processed,
  };
}

/**
 * Provider agnostic inbound round: read the stored cursor, let the source walk
 * everything published since it, ingest each page as the source retrieves it,
 * and only then advance the cursor. A message that is not durably ingested
 * aborts the round — the pages ingested before it stay ingested, and the next
 * round replays from the same cursor, where they resurface as `existing`.
 */
export async function reconcileInboundMailbox(
  target: { source: InboundMailSource; mailboxId: string },
  deps: InboundReconciliationDeps,
): Promise<{ processed: number; nextCursor: string; rebaselined: boolean }> {
  const cursor = await deps.loadCursor(target.mailboxId);
  let processed = 0;
  const fetched = await target.source.fetchSince(cursor, async (messages) => {
    let pageProcessed = 0;
    for (const message of messages) {
      const result = await deps.ingest(message);
      if (!result.ok && result.code !== "IN_PROGRESS") {
        throw new Error("Inbound delta processing not completed");
      }
      if (isProcessedIngest(result)) pageProcessed += 1;
    }
    processed += pageProcessed;
    return pageProcessed;
  });
  await deps.saveCursor(
    target.mailboxId,
    fetched.nextCursor,
    fetched.rebaselined,
  );
  return {
    processed,
    nextCursor: fetched.nextCursor,
    rebaselined: fetched.rebaselined,
  };
}

export type InboundHealthOptions = {
  lockKey: string;
  healthKey: string;
  event: string;
  workflowName: string;
  failureError: string;
  retryDelayMs?: number;
};

/**
 * The `workflowName` every provider without legacy naming reports its inbound
 * round under — and, critically, the value `send-service.ts`'s send gate
 * matches on to block sends while inbound reconciliation is unresolved. It is
 * exported (rather than written twice as a string literal, once by the
 * producer here and once by that consumer) so the compiler is what ties the
 * two together: the gate on the user's own mailbox is the one place where a
 * silent divergence would disarm the guard rather than merely rename an
 * event. Graph's equivalent lives in `microsoft-graph-inbound-naming.ts`, for
 * the same reason.
 */
export const DEFAULT_INBOUND_WORKFLOW_NAME = "inbound_reconciliation";

/**
 * Names a round for a provider that has no legacy naming to preserve.
 */
export function defaultInboundNaming(
  kind: MailProviderKind,
  mailboxId: string,
): InboundHealthOptions {
  return {
    lockKey: `inbound-delta:${kind}:${mailboxId}`,
    healthKey: `${kind}:inbound-health:${mailboxId}`,
    event: `${kind}.inbound_failed`,
    workflowName: DEFAULT_INBOUND_WORKFLOW_NAME,
    failureError: "Inbound reconciliation failed",
  };
}

/**
 * Serializes inbound rounds for one mailbox and keeps a single health event
 * per mailbox up to date, so an operator (and the send gate) can see that
 * inbound reconciliation is failing without scanning history.
 */
export async function withInboundReconciliationHealth<T>(
  db: AppDatabase,
  mailboxId: string,
  options: InboundHealthOptions,
  run: () => Promise<T>,
): Promise<T> {
  return withActionLocks(db, [options.lockKey], async () => {
    const startedAt = new Date();
    const key = options.healthKey;
    await withActionLocks(
      db,
      [actionLockKey.mailbox(mailboxId)],
      async (lockedDb) => {
        await lockedDb
          .insert(workflowEvents)
          .values({
            entityType: "mailbox",
            entityId: mailboxId,
            event: options.event,
            workflowName: options.workflowName,
            idempotencyKey: key,
            status: "started",
            startedAt,
          })
          .onConflictDoNothing();
        await lockedDb
          .update(workflowEvents)
          .set({
            status: "started",
            startedAt,
            completedAt: null,
            scheduledAt: null,
            error: null,
          })
          .where(eq(workflowEvents.idempotencyKey, key));
      },
    );
    try {
      const result = await run();
      const completedAt = new Date();
      await withActionLocks(
        db,
        [actionLockKey.mailbox(mailboxId)],
        (lockedDb) =>
          lockedDb
            .update(workflowEvents)
            .set({
              status: "succeeded",
              completedAt,
              scheduledAt: null,
              error: null,
            })
            .where(eq(workflowEvents.idempotencyKey, key)),
      );
      return result;
    } catch (error) {
      const failedAt = new Date();
      await withActionLocks(
        db,
        [actionLockKey.mailbox(mailboxId)],
        (lockedDb) =>
          lockedDb
            .update(workflowEvents)
            .set({
              status: "failed",
              scheduledAt: new Date(
                failedAt.getTime() + (options.retryDelayMs ?? 60_000),
              ),
              completedAt: failedAt,
              error: options.failureError,
            })
            .where(eq(workflowEvents.idempotencyKey, key)),
      );
      throw error;
    }
  });
}

export type InboundCursorEvents = {
  synced: string;
  rebaselined: string;
  workflowName: string;
};

export function defaultInboundCursorEvents(
  kind: MailProviderKind,
): InboundCursorEvents {
  return {
    synced: `${kind}.inbound_synced`,
    rebaselined: `${kind}.inbound_rebaselined`,
    workflowName: DEFAULT_INBOUND_WORKFLOW_NAME,
  };
}

/**
 * Builds the `saveCursor` dependency: the cursor and the audit event land in
 * one transaction, and the sync anchor is rolled back by the skew so a later
 * rebaseline overlaps this round instead of leaving a gap.
 */
export function createInboundCursorWriter(
  db: AppDatabase,
  options: {
    events: InboundCursorEvents;
    startedAt: Date;
    payload?: (round: {
      mailboxId: string;
      cursor: string;
      rebaselined: boolean;
    }) => Record<string, unknown>;
  },
): InboundReconciliationDeps["saveCursor"] {
  const anchor = new Date(options.startedAt.getTime() - INBOUND_ANCHOR_SKEW_MS);
  return async (mailboxId, cursor, rebaselined) => {
    const completedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(mailboxConnections)
        .set({ syncCursor: cursor, lastSyncedAt: anchor })
        .where(eq(mailboxConnections.id, mailboxId));
      await tx.insert(workflowEvents).values({
        entityType: "mailbox",
        entityId: mailboxId,
        event: rebaselined ? options.events.rebaselined : options.events.synced,
        workflowName: options.events.workflowName,
        status: "succeeded",
        completedAt,
        payload: options.payload
          ? options.payload({ mailboxId, cursor, rebaselined })
          : { rebaselined },
      });
    });
  };
}
