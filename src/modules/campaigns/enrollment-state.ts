import type { enrollments } from "@/lib/db/schema";

export type EnrollmentState = (typeof enrollments.$inferSelect)["state"];

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
