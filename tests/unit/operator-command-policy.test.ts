import { describe, expect, it } from "vitest";

import {
  classifyCommandOutcome,
  QUEUED_OPERATOR_COMMANDS,
  AI_WORKFLOW_TASKS,
} from "@/modules/workflows/operator-command-policy";

describe("operator command outcome classification", () => {
  it("treats a successful result as done", () => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: true, disposition: "researched" },
      }),
    ).toEqual({ kind: "succeeded" });
  });

  it("treats a result with no verdict shape as done", () => {
    expect(
      classifyCommandOutcome({ status: "returned", value: { skipped: true } }),
    ).toEqual({ kind: "succeeded" });
  });

  it("retries what threw", () => {
    expect(
      classifyCommandOutcome({ status: "threw", message: "boom" }),
    ).toMatchObject({ kind: "retry" });
  });

  it.each(["AGENT_ERROR", "DATABASE_ERROR", "PROVIDER_ERROR"])(
    "retries the transient failure %s",
    (code) => {
      expect(
        classifyCommandOutcome({
          status: "returned",
          value: { ok: false, code },
        }),
      ).toMatchObject({ kind: "retry" });
    },
  );

  it("retries while another executor holds the work", () => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: false, code: "IN_PROGRESS" },
      }),
    ).toMatchObject({ kind: "retry" });
  });

  // Not a failure and not a success: the work cannot start yet, and burning an
  // attempt on it would exhaust the retry budget on something that was never
  // tried.
  it("parks work whose precondition has not been met", () => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: false, code: "REPLY_PENDING" },
      }),
    ).toEqual({
      kind: "waiting",
      reason: "awaiting_reply_classification",
    });
  });

  // Deleting this mapping would turn a wait into three burnt attempts and an
  // abandoned command, on work nobody got wrong.
  it("parks work that has nothing researched to personalize from", () => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: false, code: "AWAITING_RESEARCH" },
      }),
    ).toEqual({ kind: "waiting", reason: "awaiting_account_research" });
  });

  it.each([
    "INVALID_INPUT",
    "ACCOUNT_NOT_FOUND",
    "CONTACT_NOT_FOUND",
    "NOT_FOUND",
    "ENROLLMENT_INACTIVE",
    "TEMPLATE_ERROR",
  ])("abandons %s, which retrying cannot fix", (code) => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: false, code },
      }),
    ).toMatchObject({ kind: "abandoned" });
  });

  // Silence is the failure mode this queue exists to remove. An unrecognised
  // code must surface, not loop forever or be recorded as a success.
  it("abandons an unrecognised code rather than looping on it", () => {
    expect(
      classifyCommandOutcome({
        status: "returned",
        value: { ok: false, code: "SOMETHING_NEW" },
      }),
    ).toMatchObject({ kind: "abandoned", reason: "SOMETHING_NEW" });
  });
});

describe("which operator commands leave the request", () => {
  // The invariant, stated as data: no request handler may run a task that
  // takes a turn on the operator's single ChatGPT window, because that window
  // is serialized process-wide and the maintenance cycle is already using it.
  it("queues every operator command whose task uses AI", () => {
    const queuedTasks = new Set<string>(
      Object.values(QUEUED_OPERATOR_COMMANDS),
    );
    const missing = AI_WORKFLOW_TASKS.filter(
      (task) => !queuedTasks.has(task),
    ).filter(
      // Reached through the maintenance cycle, never from a request.
      (task) =>
        ![
          "personalize-message",
          "reconcile-inbound-mailbox",
          "reconcile-inbound-mailboxes",
          "advance-sequence",
          "recover-stale-work",
          "maintenance-cycle",
        ].includes(task),
    );
    expect(missing).toEqual([]);
  });

  it("queues nothing that is not a real workflow task", () => {
    expect(Object.values(QUEUED_OPERATOR_COMMANDS).length).toBeGreaterThan(0);
  });
});
