import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import {
  accounts,
  contacts,
  messages,
  stateTransitions,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";
import { findDueEnrollments } from "@/modules/workflows/follow-up-service";

/**
 * How long the worker may keep trying to finish a send after somebody asked
 * for it. It has to outlast one claim lease (5 minutes) plus the SMTP provider
 * timeout (150 seconds), or a healthy in-flight send would be taken away from
 * itself. Past it, an unfinished send is no longer a request being completed —
 * it is an old intention, and the operator decides again.
 */
export const SEND_COMPLETION_WINDOW_MS = 20 * 60_000;

export function recoveryDispatchKey(now: Date): string {
  return `recovery:${now.toISOString().slice(0, 16)}`;
}

/**
 * Hands back every `drafted` message the worker may no longer finish: the ones
 * whose request has aged out, and the ones that carry no request at all
 * because a reconciliation put them there. Both would otherwise be invisible —
 * excluded from recovery by the window, and hidden from the operator because
 * the review card's Send button renders on `approved` only.
 *
 * `providerDraftId` is deliberately kept: the next claim branches on it and
 * resumes the existing provider draft instead of creating a second one.
 */
export async function releaseExpiredSendRequests(
  db: AppDatabase,
  options: { now?: Date; sendWindowMs?: number; limit?: number } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const requestedAfter = new Date(
    now.getTime() - (options.sendWindowMs ?? SEND_COMPLETION_WINDOW_MS),
  );
  const expired = await db
    .select({ id: messages.id, requestedAt: messages.sendRequestedAt })
    .from(messages)
    .where(
      and(
        eq(messages.status, "drafted"),
        or(
          sql`${messages.sendRequestedAt} is null`,
          lt(messages.sendRequestedAt, requestedAfter),
        ),
      ),
    )
    .orderBy(asc(messages.updatedAt), asc(messages.id))
    .limit(limit);
  if (expired.length === 0) return [];

  const released: string[] = [];
  for (const row of expired) {
    const [updated] = await db
      .update(messages)
      .set({
        status: "approved",
        sendRequestedAt: null,
        sendAttemptToken: null,
        sendClaimedAt: null,
        lastError: row.requestedAt
          ? "Send was not completed in time and is waiting for you again"
          : "This draft was recovered from the mailbox and is waiting for you",
      })
      .where(and(eq(messages.id, row.id), eq(messages.status, "drafted")))
      .returning({ id: messages.id });
    if (!updated) continue;
    await db.insert(stateTransitions).values({
      entityType: "message",
      entityId: row.id,
      fromState: "drafted",
      toState: "approved",
      reason: row.requestedAt
        ? "send_request_window_expired"
        : "drafted_without_send_request",
    });
    released.push(row.id);
  }
  return released;
}

export async function dispatchDueFollowUps(
  db: AppDatabase,
  dispatcher: WorkflowDispatcher,
  options: { now?: Date; limit?: number } = {},
) {
  const due = await findDueEnrollments(db, options);
  const results = [];
  for (const item of due) {
    results.push(
      await dispatcher.dispatch({
        task: "advance-sequence",
        payload: {
          enrollmentId: item.enrollmentId,
          expectedStep: item.expectedStep,
          expectedVersionId: item.expectedVersionId,
          expectedDueAt: item.expectedDueAt.toISOString(),
          expectedToken: item.expectedToken,
        },
        idempotencyKey: `followup:${item.enrollmentId}:${item.expectedToken}`,
      }),
    );
  }
  return results;
}

export async function findStaleRecoveryCandidates(
  db: AppDatabase,
  options: {
    now?: Date;
    limit?: number;
    messageLimit?: number;
    claimLeaseMs?: number;
    sendWindowMs?: number;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const messageLimit = Math.min(
    Math.max(options.messageLimit ?? limit, 1),
    200,
  );
  const staleBefore = new Date(
    now.getTime() - (options.claimLeaseMs ?? 5 * 60_000),
  );
  const requestedAfter = new Date(
    now.getTime() - (options.sendWindowMs ?? SEND_COMPLETION_WINDOW_MS),
  );
  const uncertainQuota =
    messageLimit > 1 ? Math.max(1, Math.floor(messageLimit / 4)) : 0;
  const actionableQuota = messageLimit - uncertainQuota;
  const [
    actionableMessages,
    uncertainMessages,
    staleResearch,
    staleEmailResolution,
  ] = await Promise.all([
    db
      .select({ id: messages.id })
      .from(messages)
      .where(
        // Recovery resumes a send somebody already requested and left
        // unfinished. `approved` is deliberately excluded: it is a review
        // decision, not a send request, so recovering it would turn every
        // approval into an automatic send on the next maintenance tick.
        // `drafted` is bounded by the request clock rather than left open: a
        // send refused by the final policy check lands there, and without a
        // bound the worker would keep retrying it until the window reopened
        // hours later and delivered it with no human gesture behind it.
        or(
          and(
            inArray(messages.status, ["drafted"]),
            gte(messages.sendRequestedAt, requestedAfter),
          ),
          and(
            inArray(messages.status, ["draft_creating", "sending"]),
            lt(messages.sendClaimedAt, staleBefore),
          ),
        ),
      )
      // Ordered on the marker the database owns, not on creation, so a
      // permanently refused message yields its slot on the next tick instead
      // of holding the single actionable quota forever. `recordBlocked`'s
      // write to `last_error` is what moves it.
      .orderBy(asc(messages.updatedAt), asc(messages.id))
      .limit(actionableQuota),
    uncertainQuota === 0
      ? Promise.resolve([])
      : db
          .select({ id: messages.id })
          .from(messages)
          .where(inArray(messages.status, ["delivery_uncertain"]))
          .orderBy(asc(messages.updatedAt), asc(messages.id))
          .limit(uncertainQuota),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          isNotNull(accounts.researchClaimId),
          lt(accounts.researchClaimedAt, staleBefore),
        ),
      )
      .orderBy(asc(accounts.researchClaimedAt))
      .limit(limit),
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          isNotNull(contacts.emailResolutionClaimId),
          lt(contacts.emailResolutionClaimedAt, staleBefore),
        ),
      )
      .orderBy(asc(contacts.emailResolutionClaimedAt))
      .limit(limit),
  ]);
  if (uncertainMessages.length > 0) {
    await db
      .update(messages)
      .set({ updatedAt: now })
      .where(
        inArray(
          messages.id,
          uncertainMessages.map((row) => row.id),
        ),
      );
  }
  return {
    messageIds: [...actionableMessages, ...uncertainMessages].map(
      (row) => row.id,
    ),
    accountIds: staleResearch.map((row) => row.id),
    contactIds: staleEmailResolution.map((row) => row.id),
  };
}
