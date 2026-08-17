import { describe, expect, it, vi } from "vitest";

import maintenanceConfig from "../../config/maintenance.json";

import {
  TestWorkflowDispatcher,
  TriggerWorkflowDispatcher,
} from "@/modules/workflows/dispatcher";
import {
  parseWorkflowPayload,
  WORKFLOW_TASKS,
  workflowTaskNames,
} from "@/modules/workflows/task-contracts";
import { recoveryDispatchKey } from "@/modules/workflows/recovery-service";

describe("workflow dispatcher contracts", () => {
  it("loads every production task from a plain worker module graph", async () => {
    const taskModule = await import("../../trigger/tasks");

    expect(Object.keys(taskModule).sort()).toEqual([
      "accountDiscoveryTask",
      "accountResearchTask",
      "advanceSequenceTask",
      "contactDiscoveryTask",
      "drainGraphWebhooksTask",
      "emailResolutionTask",
      "generateMessageTask",
      "maintainGraphSubscriptionsTask",
      "maintenanceCycleTask",
      "personalizeMessageTask",
      "reconcileDueFollowUpsTask",
      "reconcileInboundMailboxTask",
      "reconcileInboundMailboxesTask",
      "recoverStaleWorkTask",
      "sendApprovedMessageTask",
    ]);
  });

  it("declares the complete durable task surface with bounded execution", () => {
    expect(workflowTaskNames).toEqual([
      "account-discovery",
      "account-research",
      "contact-discovery",
      "email-resolution",
      "personalize-message",
      "generate-message",
      "send-approved-message",
      "advance-sequence",
      "reconcile-due-follow-ups",
      "drain-graph-webhooks",
      "reconcile-inbound-mailbox",
      "reconcile-inbound-mailboxes",
      "maintain-graph-subscriptions",
      "recover-stale-work",
      "maintenance-cycle",
    ]);
    for (const definition of Object.values(WORKFLOW_TASKS)) {
      expect(definition.maxDuration).toBeGreaterThanOrEqual(30);
      // Read from the shared timing contract rather than repeated here, so a
      // budget change cannot leave this bound silently stale.
      expect(definition.maxDuration).toBeLessThanOrEqual(
        maintenanceConfig.aggregateBudgetMs / 1_000,
      );
      expect(definition.retry.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(definition.retry.maxAttempts).toBeLessThanOrEqual(5);
    }
  });

  it("deduplicates local duplicate delivery by task and global key", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const dispatcher = new TestWorkflowDispatcher(execute, () => "local-run-1");

    const first = await dispatcher.dispatch({
      task: "account-research",
      payload: { accountId: "295c8514-b87b-4ea4-8606-4b13f90f814a" },
      idempotencyKey: "research:295c8514-b87b-4ea4-8606-4b13f90f814a:v1",
    });
    const duplicate = await dispatcher.dispatch({
      task: "account-research",
      payload: { accountId: "295c8514-b87b-4ea4-8606-4b13f90f814a" },
      idempotencyKey: "research:295c8514-b87b-4ea4-8606-4b13f90f814a:v1",
    });

    expect(first).toMatchObject({ runId: "local-run-1", duplicate: false });
    expect(duplicate).toMatchObject({ runId: "local-run-1", duplicate: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("creates an explicit globally-scoped Trigger idempotency key", async () => {
    const createIdempotencyKey = vi.fn(async (key: string) => `hash:${key}`);
    const trigger = vi.fn(async () => ({ id: "run_trigger_1" }));
    const dispatcher = new TriggerWorkflowDispatcher({
      createGlobalIdempotencyKey: createIdempotencyKey,
      trigger,
    });

    await expect(
      dispatcher.dispatch({
        task: "reconcile-inbound-mailbox",
        payload: { mailboxId: "0260a999-4faa-4590-aadc-fd65c27c0ce7" },
        idempotencyKey:
          "delta:0260a999-4faa-4590-aadc-fd65c27c0ce7:2026-08-12T10:00",
      }),
    ).resolves.toEqual({ runId: "run_trigger_1", duplicate: false });
    expect(createIdempotencyKey).toHaveBeenCalledWith(
      "reconcile-inbound-mailbox:delta:0260a999-4faa-4590-aadc-fd65c27c0ce7:2026-08-12T10:00",
      { scope: "global" },
    );
    expect(trigger).toHaveBeenCalledWith(
      "reconcile-inbound-mailbox",
      { mailboxId: "0260a999-4faa-4590-aadc-fd65c27c0ce7" },
      {
        idempotencyKey:
          "hash:reconcile-inbound-mailbox:delta:0260a999-4faa-4590-aadc-fd65c27c0ce7:2026-08-12T10:00",
      },
    );
  });

  it("strictly validates every untrusted task payload", () => {
    expect(() =>
      parseWorkflowPayload("advance-sequence", {
        enrollmentId: "not-a-uuid",
        expectedStep: -1,
        expectedVersionId: "also-invalid",
        expectedDueAt: "tomorrow",
        expectedToken: "",
        surprise: "field",
      }),
    ).toThrow();
    expect(
      parseWorkflowPayload("send-approved-message", {
        messageId: "295c8514-b87b-4ea4-8606-4b13f90f814a",
      }),
    ).toEqual({ messageId: "295c8514-b87b-4ea4-8606-4b13f90f814a" });
    expect(
      parseWorkflowPayload("maintenance-cycle", {
        observedAt: "2026-08-14T10:42:00.000Z",
      }),
    ).toEqual({ observedAt: "2026-08-14T10:42:00.000Z" });
    expect(() =>
      parseWorkflowPayload("maintenance-cycle", {
        observedAt: "2026-08-14T10:42:00.000Z",
        untrusted: true,
      }),
    ).toThrow();
  });

  /**
   * The payloads the operator UI actually posts, parsed by the exact function
   * the runtime calls before executing a task.
   *
   * These schemas are `.strict()` and the payload *types* beside them are a
   * separate declaration: `satisfies Record<WorkflowTaskName, z.ZodType>` does
   * not bind one to the other, so a field can be added to the type, typecheck
   * clean, and be rejected at run time on every click. That is not theoretical
   * — `forcePublicSearch` shipped that way, and because the route sends the key
   * whether or not the box is ticked, it would have thrown on every single
   * resolution, retried the whole ladder, and abandoned ~21 minutes later.
   */
  it("accepts the payloads the operator routes actually build", () => {
    const contactId = "b5da6eec-cfed-42e8-9ac9-aca719ddff90";
    // Box ticked, and — the case that matters — box left alone: `boolean()`
    // returns false rather than omitting the key.
    for (const forcePublicSearch of [true, false]) {
      expect(
        parseWorkflowPayload("email-resolution", {
          contactId,
          confidenceThreshold: 0.85,
          forcePublicSearch,
        }),
      ).toMatchObject({ contactId, forcePublicSearch });
    }
    expect(
      parseWorkflowPayload("account-research", {
        accountId: "7b082ffe-0ed4-43cc-8744-1889d552d29b",
        force: false,
      }),
    ).toMatchObject({ force: false });
    // The strictness itself must survive: an unknown key is still refused.
    expect(() =>
      parseWorkflowPayload("email-resolution", {
        contactId,
        surprise: true,
      }),
    ).toThrow();
  });

  it("uses a stable minute bucket for duplicate recovery scheduler calls", () => {
    expect(recoveryDispatchKey(new Date("2026-08-12T10:42:59.999Z"))).toBe(
      "recovery:2026-08-12T10:42",
    );
  });
});
