import { and, eq } from "drizzle-orm";

import {
  contacts,
  emailCandidates,
  enrollments,
  sequenceSteps,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import { stepDeclaresPersonalization } from "@/modules/messages/personalization-declaration";
import {
  AI_WORKFLOW_TASKS,
  type WaitingReason,
} from "@/modules/workflows/operator-command-policy";

/**
 * What the queue should do with a command it has just claimed, before it
 * spends an attempt on it.
 *
 * Three answers, not two. "Run it" and "wait, the precondition is not met yet"
 * were the original pair, and they cannot express the case where the
 * precondition will never be met because the work no longer has a subject —
 * an enrolment that was stopped, or deleted. Left as a wait, such a row asks
 * the database the same question every five minutes forever. It is cheap, and
 * it is still wrong: the queue would be telling the operator it is waiting for
 * something that is not coming.
 */
export type PreparedCommand =
  | { kind: "ready"; payload: Record<string, unknown>; usesAi: boolean }
  | { kind: "waiting"; reason: WaitingReason }
  | { kind: "abandon"; reason: string };

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
  return stepDeclaresPersonalization(step?.declared);
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
    // Research and discovery commands can be orphaned the same way — by an
    // account deleted between queueing and draining. They are deliberately
    // left alone: their subject is not read here, and inventing a second
    // ownership rule for them belongs with the command that needs it.
    return {
      kind: "ready",
      payload: row.payload,
      usesAi: await commandTakesAiTurn(db, row),
    };
  }
  const enrollmentId = row.payload.enrollmentId;
  if (typeof enrollmentId !== "string") {
    return {
      kind: "ready",
      payload: row.payload,
      usesAi: await commandTakesAiTurn(db, row),
    };
  }

  // Is there still somebody to write to? Asked before the address, because a
  // stopped enrolment has no address question left to answer.
  const [enrollment] = await db
    .select({ state: enrollments.state })
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  if (!enrollment) {
    return {
      kind: "abandon",
      reason: "The enrolment this message was queued for no longer exists",
    };
  }
  // `isTerminalEnrollmentState` and not a list written here: it is the tree's
  // one answer to "is this sequence over", and it deliberately excludes
  // `paused` and `manual_review`, which resume. Those stay waiting.
  if (isTerminalEnrollmentState(enrollment.state)) {
    return {
      kind: "abandon",
      reason: `This prospect's sequence ended before the message was written (${enrollment.state})`,
    };
  }
  // A caller that already knows the address keeps it. The follow-up path does:
  // it addresses the thread it is following, which is the previous step's
  // recipient. Only work queued without one — an enrolment, whose prospect may
  // have no resolved address yet — waits for resolution to answer.
  const carried = row.payload.recipient;
  if (typeof carried === "string" && carried.trim().length > 0) {
    return {
      kind: "ready",
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
  if (!accepted) return { kind: "waiting", reason: "awaiting_accepted_email" };
  return {
    kind: "ready",
    payload: { ...row.payload, recipient: accepted.email },
    usesAi: await commandTakesAiTurn(db, row),
  };
}
