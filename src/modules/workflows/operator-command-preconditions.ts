import { and, eq } from "drizzle-orm";

import { contacts, emailCandidates, enrollments } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { WaitingReason } from "@/modules/workflows/operator-command-policy";

export type PreparedCommand =
  | { ready: true; payload: Record<string, unknown> }
  | { ready: false; reason: WaitingReason };

/**
 * Fills in what a queued command needs but could not know when it was queued,
 * and says so plainly when the answer is still missing.
 *
 * Enrolling a prospect queues their first message immediately, before their
 * address has necessarily been resolved. That is not a failure to retry — no
 * number of attempts produces an email nobody has found yet — so it becomes a
 * wait, spends no retry budget, and clears itself the moment resolution
 * accepts a candidate. Asking the database each pass, rather than having the
 * resolver notify the queue, means a row cannot be stranded because a producer
 * forgot to.
 */
export async function prepareCommand(
  db: AppDatabase,
  row: { task: string; payload: Record<string, unknown> },
): Promise<PreparedCommand> {
  if (row.task !== "generate-message") {
    return { ready: true, payload: row.payload };
  }
  const enrollmentId = row.payload.enrollmentId;
  if (typeof enrollmentId !== "string") {
    return { ready: true, payload: row.payload };
  }
  const [accepted] = await db
    .select({ email: emailCandidates.normalizedEmail })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(
      emailCandidates,
      and(
        eq(emailCandidates.contactId, contacts.id),
        eq(emailCandidates.status, "accepted"),
      ),
    )
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  if (!accepted) return { ready: false, reason: "awaiting_accepted_email" };
  return {
    ready: true,
    payload: { ...row.payload, recipient: accepted.email },
  };
}
