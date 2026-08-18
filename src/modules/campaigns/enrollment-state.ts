import type { enrollments } from "@/lib/db/schema";

export type EnrollmentState = (typeof enrollments.$inferSelect)["state"];

/**
 * `failed` is reachable by no code path in this product.
 *
 * It has been in the enum since the first migration and nothing has ever
 * written it: a send that cannot go out leaves the *message* failed and parks
 * the enrollment in `manual_review`, because a human decides what happens to a
 * prospect. It is kept, and kept terminal, on purpose — dropping it from this
 * list is the only change that could do harm, since a row that somehow held it
 * would then be treated as live and could be resurrected by the address ladder.
 * Listed terminal it fails closed, and costs nothing.
 */
export const TERMINAL_ENROLLMENT_STATES = [
  "replied",
  "bounced",
  "opted_out",
  "completed",
  "stopped",
  "failed",
] as const satisfies readonly EnrollmentState[];

const terminalEnrollmentStates = new Set<EnrollmentState>(
  TERMINAL_ENROLLMENT_STATES,
);

export function isTerminalEnrollmentState(state: EnrollmentState): boolean {
  return terminalEnrollmentStates.has(state);
}

/**
 * The states a message may still be written for.
 *
 * Lives beside the terminal list rather than in the page that renders the
 * button, because the only thing that makes it correct is its relationship to
 * that list: offering to write a message for a prospect the product considers
 * finished queues work the send policy then refuses. `failed` used to sit here
 * — the one terminal state in it — and nothing ever noticed, because nothing
 * reaches `failed`. The guard test asserts the rule rather than the contents.
 */
export const GENERATABLE_ENROLLMENT_STATES = [
  "ready_for_review",
  "approved",
  "active",
  "waiting",
  "manual_review",
  "paused",
] as const satisfies readonly EnrollmentState[];
