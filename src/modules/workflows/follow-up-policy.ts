export function calculateNextActionAt(
  sentAt: Date,
  delayMinutes: number,
): Date {
  if (!Number.isInteger(delayMinutes) || delayMinutes < 0) {
    throw new Error("Invalid follow-up delay");
  }
  return new Date(sentAt.getTime() + delayMinutes * 60_000);
}

type CurrentSchedule = {
  enrollmentState: string;
  campaignVersionId: string;
  currentStep: number;
  nextActionAt: Date | null;
  nextActionToken: string | null;
};

type ExpectedSchedule = {
  expectedStep: number;
  expectedVersionId: string;
  expectedDueAt: Date;
  expectedToken: string;
};

export function validateWorkflowInvocation(
  current: CurrentSchedule,
  expected: ExpectedSchedule,
  now: Date,
): { ok: true } | { ok: false; code: "STALE_INVOCATION" | "NOT_DUE" } {
  if (
    !["waiting", "ready_for_review", "approved"].includes(
      current.enrollmentState,
    ) ||
    current.campaignVersionId !== expected.expectedVersionId ||
    current.currentStep !== expected.expectedStep ||
    current.nextActionToken !== expected.expectedToken ||
    current.nextActionAt?.getTime() !== expected.expectedDueAt.getTime()
  ) {
    return { ok: false, code: "STALE_INVOCATION" };
  }
  if (now.getTime() < expected.expectedDueAt.getTime()) {
    return { ok: false, code: "NOT_DUE" };
  }
  return { ok: true };
}
