import { describe, expect, it } from "vitest";

import {
  WORKFLOW_TASKS,
  workflowTaskNames,
} from "@/modules/workflows/task-contracts";

describe("inbound sync task", () => {
  it("is named after the mailbox concept, not the Graph provider", () => {
    expect(workflowTaskNames).toContain("reconcile-inbound-mailbox");
    expect(workflowTaskNames).toContain("reconcile-inbound-mailboxes");
    expect(workflowTaskNames).not.toContain("reconcile-graph-delta");
  });

  it("defines a bounded scheduled sweep for available SMTP/IMAP mailboxes", () => {
    expect(WORKFLOW_TASKS["reconcile-inbound-mailboxes"]).toEqual({
      maxDuration: 300,
      retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
    });
  });

  it("keeps the retry envelope of the task it replaces", () => {
    expect(WORKFLOW_TASKS["reconcile-inbound-mailbox"]).toEqual({
      maxDuration: 300,
      retry: { maxAttempts: 4, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
    });
  });
});
