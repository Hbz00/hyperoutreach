import { and, asc, inArray, isNotNull, lt, or } from "drizzle-orm";

import { accounts, contacts, messages } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";
import { findDueEnrollments } from "@/modules/workflows/follow-up-service";

export function recoveryDispatchKey(now: Date): string {
  return `recovery:${now.toISOString().slice(0, 16)}`;
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
        // `drafted` stays ungated because it is only reachable through a real
        // send attempt that created a provider draft and released its claim.
        or(
          inArray(messages.status, ["drafted"]),
          and(
            inArray(messages.status, ["draft_creating", "sending"]),
            lt(messages.sendClaimedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(messages.createdAt))
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
