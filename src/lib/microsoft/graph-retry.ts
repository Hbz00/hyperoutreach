import { eq, sql } from "drizzle-orm";

import { workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { GraphApiError } from "@/lib/microsoft/graph-client";

export class GraphRetryDeferredError extends Error {
  constructor(readonly retryAt: Date) {
    super("Microsoft Graph retry is deferred");
  }
}

export function graphRetryDeadline(
  error: unknown,
  now: Date,
  policyDelayMs: number,
): Date {
  // A deferred operation did no provider work. Keep its original deadline;
  // adding the policy again on every poll would postpone recovery forever.
  if (error instanceof GraphRetryDeferredError) return error.retryAt;
  const seconds =
    error instanceof GraphApiError ? error.retryAfterSeconds : null;
  const providerTime =
    seconds !== null && Number.isFinite(seconds) && seconds >= 0
      ? now.getTime() + seconds * 1_000
      : NaN;
  return new Date(
    Math.max(
      now.getTime() + policyDelayMs,
      Number.isFinite(new Date(providerTime).getTime()) ? providerTime : 0,
    ),
  );
}

export async function graphRetryNotBefore(db: AppDatabase, mailboxId: string) {
  const [event] = await db
    .select({ scheduledAt: workflowEvents.scheduledAt })
    .from(workflowEvents)
    .where(
      eq(workflowEvents.idempotencyKey, `graph:provider-retry:${mailboxId}`),
    )
    .limit(1);
  return event?.scheduledAt ?? null;
}

export async function assertGraphRetryReady(
  db: AppDatabase,
  mailboxId: string,
  now: Date,
) {
  const retryAt = await graphRetryNotBefore(db, mailboxId);
  if (retryAt && retryAt > now) throw new GraphRetryDeferredError(retryAt);
}

export async function recordGraphRetry(
  db: AppDatabase,
  mailboxId: string,
  error: unknown,
  now: Date,
  policyDelayMs: number,
): Promise<Date> {
  // The request may have spent seconds in flight. Retry-After starts when
  // the provider failure is observed, never at the earlier selection time.
  const observedAt = new Date(Math.max(now.getTime(), Date.now()));
  const deadline = graphRetryDeadline(error, observedAt, policyDelayMs);
  const [event] = await db
    .insert(workflowEvents)
    .values({
      entityType: "mailbox",
      entityId: mailboxId,
      event: "graph.provider_retry_deferred",
      workflowName: "graph_provider_retry",
      idempotencyKey: `graph:provider-retry:${mailboxId}`,
      status: "failed",
      scheduledAt: deadline,
      completedAt: observedAt,
      error: "Microsoft Graph operation deferred for retry",
    })
    .onConflictDoUpdate({
      target: workflowEvents.idempotencyKey,
      targetWhere: sql`${workflowEvents.idempotencyKey} is not null`,
      set: {
        status: "failed",
        completedAt: observedAt,
        scheduledAt: sql`greatest(${workflowEvents.scheduledAt}, ${deadline.toISOString()}::timestamptz)`,
        error: "Microsoft Graph operation deferred for retry",
      },
    })
    .returning({ scheduledAt: workflowEvents.scheduledAt });
  return event!.scheduledAt!;
}
