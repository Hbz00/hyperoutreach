import { describe, expect, it } from "vitest";

import {
  calculateNextActionAt,
  validateWorkflowInvocation,
} from "@/modules/workflows/follow-up-policy";

describe("follow-up schedule policy", () => {
  it("calculates the due time from the confirmed send time and immutable delay", () => {
    expect(
      calculateNextActionAt(new Date("2026-08-11T10:00:00.000Z"), 90),
    ).toEqual(new Date("2026-08-11T11:30:00.000Z"));
  });

  it("accepts only the exact current durable invocation", () => {
    const current = {
      enrollmentState: "waiting" as const,
      campaignVersionId: "version-1",
      currentStep: 1,
      nextActionAt: new Date("2026-08-12T10:00:00.000Z"),
      nextActionToken: "token-1",
    };
    const expected = {
      expectedStep: 1,
      expectedVersionId: "version-1",
      expectedDueAt: new Date("2026-08-12T10:00:00.000Z"),
      expectedToken: "token-1",
    };
    expect(
      validateWorkflowInvocation(
        current,
        expected,
        new Date("2026-08-12T10:00:01Z"),
      ),
    ).toEqual({ ok: true });
    expect(
      validateWorkflowInvocation(
        current,
        { ...expected, expectedToken: "old-token" },
        new Date("2026-08-12T10:00:01Z"),
      ),
    ).toEqual({ ok: false, code: "STALE_INVOCATION" });
    expect(
      validateWorkflowInvocation(
        current,
        expected,
        new Date("2026-08-12T09:59:59Z"),
      ),
    ).toEqual({ ok: false, code: "NOT_DUE" });
  });
});
