import { and, eq } from "drizzle-orm";

import {
  contacts,
  emailCandidates,
  enrollments,
  sequenceSteps,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  AI_WORKFLOW_TASKS,
  type WaitingReason,
} from "@/modules/workflows/operator-command-policy";

export type PreparedCommand =
  | { ready: true; payload: Record<string, unknown>; usesAi: boolean }
  | { ready: false; reason: WaitingReason };

/**
 * Whether running this command will take a turn on the operator's single
 * ChatGPT window.
 *
 * For most tasks the answer is the task name. `generate-message` is the one
 * task whose answer is in the data: it is deterministic interpolation until a
 * sequence step declares a field for an agent to write, and then it is a live
 * turn. The queue stops a pass at its first AI turn, so answering "no" here
 * for a step that does declare one would let a burst of enrolments spend the
 * window several times over in a single pass — which is exactly the bound's
 * reason to exist.
 *
 * The declaration is the discriminator rather than whether the agent would
 * actually be reached: a declared step whose account has no research returns
 * `AWAITING_RESEARCH` without calling anybody. Over-counting there costs one
 * deferred command; under-counting costs the window.
 */
async function commandTakesAiTurn(
  db: AppDatabase,
  row: { task: string; payload: Record<string, unknown> },
): Promise<boolean> {
  if ((AI_WORKFLOW_TASKS as readonly string[]).includes(row.task)) return true;
  if (row.task !== "generate-message") return false;
  const enrollmentId = row.payload.enrollmentId;
  const stepIndex = row.payload.stepIndex;
  if (typeof enrollmentId !== "string" || typeof stepIndex !== "number") {
    return false;
  }
  const [step] = await db
    .select({ declared: sequenceSteps.personalizationSchema })
    .from(enrollments)
    .innerJoin(
      sequenceSteps,
      and(
        eq(sequenceSteps.campaignVersionId, enrollments.campaignVersionId),
        eq(sequenceSteps.stepIndex, stepIndex),
      ),
    )
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  const declared = step?.declared as { fields?: unknown } | null | undefined;
  return Array.isArray(declared?.fields) && declared.fields.length > 0;
}

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
    return {
      ready: true,
      payload: row.payload,
      usesAi: await commandTakesAiTurn(db, row),
    };
  }
  const enrollmentId = row.payload.enrollmentId;
  if (typeof enrollmentId !== "string") {
    return {
      ready: true,
      payload: row.payload,
      usesAi: await commandTakesAiTurn(db, row),
    };
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
    usesAi: await commandTakesAiTurn(db, row),
  };
}
