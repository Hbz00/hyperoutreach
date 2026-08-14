import { beforeEach, describe, expect, it, vi } from "vitest";

import maintenanceConfig from "../../config/maintenance.json";
import { WORKFLOW_TASKS } from "@/modules/workflows/task-contracts";

const triggerHarness = vi.hoisted(() => ({
  execute: vi.fn(),
  regularDefinitions: [] as Array<Record<string, unknown>>,
  scheduledDefinitions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@trigger.dev/sdk", () => ({
  defineConfig: (config: Record<string, unknown>) => config,
  task: (definition: Record<string, unknown>) => {
    triggerHarness.regularDefinitions.push(definition);
    return { id: definition.id, kind: "regular", definition };
  },
  schedules: {
    task: (definition: Record<string, unknown>) => {
      triggerHarness.scheduledDefinitions.push(definition);
      return { id: definition.id, kind: "scheduled", definition };
    },
  },
}));

vi.mock("@/lib/db/client-core", () => ({
  getDatabase: () => ({ database: "test" }),
}));

vi.mock("@/modules/workflows/service-factory", () => ({
  createWorkflowTaskServices: () => ({ services: "test" }),
}));

vi.mock("@/modules/workflows/runtime", () => ({
  WorkflowRuntime: class {
    execute(...args: unknown[]) {
      return triggerHarness.execute(...args);
    }
  },
}));

describe("Trigger task module", () => {
  beforeEach(() => {
    triggerHarness.execute.mockReset();
  });

  it("exports narrow maintenance tasks as callable regular tasks and schedules only the ordered cycle each minute", async () => {
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

    expect(
      triggerHarness.regularDefinitions
        .map((definition) => definition.id)
        .filter((id) =>
          [
            "reconcile-inbound-mailboxes",
            "reconcile-due-follow-ups",
            "recover-stale-work",
          ].includes(String(id)),
        )
        .sort(),
    ).toEqual([
      "reconcile-due-follow-ups",
      "reconcile-inbound-mailboxes",
      "recover-stale-work",
    ]);

    expect(
      triggerHarness.scheduledDefinitions.map((definition) => ({
        id: definition.id,
        cron: definition.cron,
      })),
    ).toEqual([
      { id: "maintenance-cycle", cron: "* * * * *" },
      { id: "maintain-graph-subscriptions", cron: "*/5 * * * *" },
    ]);

    const maintenanceTask = triggerHarness.scheduledDefinitions.find(
      (definition) => definition.id === "maintenance-cycle",
    );
    expect(maintenanceTask).toMatchObject({
      ttl: "15m",
      maxDuration: maintenanceConfig.aggregateBudgetMs / 1_000,
      retry: {
        ...WORKFLOW_TASKS["maintenance-cycle"].retry,
        factor: 2,
        randomize: true,
      },
    });
  });

  it("passes the Trigger schedule timestamp to the aggregate workflow runtime", async () => {
    await import("../../trigger/tasks");
    const maintenanceTask = triggerHarness.scheduledDefinitions.find(
      (definition) => definition.id === "maintenance-cycle",
    );
    const run = maintenanceTask?.run as
      | ((
          payload: { timestamp: Date },
          context: {
            ctx: { run: { id: string }; attempt: { number: number } };
          },
        ) => Promise<unknown>)
      | undefined;
    triggerHarness.execute.mockResolvedValue({ outcome: "succeeded" });

    await expect(
      run?.(
        { timestamp: new Date("2026-08-14T10:42:00.000Z") },
        { ctx: { run: { id: "run_maintenance" }, attempt: { number: 2 } } },
      ),
    ).resolves.toEqual({ outcome: "succeeded" });
    expect(triggerHarness.execute).toHaveBeenCalledWith(
      "maintenance-cycle",
      { observedAt: "2026-08-14T10:42:00.000Z" },
      { runId: "run_maintenance", attempt: 2 },
    );
  });

  it("keeps the Trigger project ceiling equal to the shared aggregate budget", async () => {
    const triggerConfig = (await import("../../trigger.config")).default;

    expect(triggerConfig.maxDuration).toBe(
      maintenanceConfig.aggregateBudgetMs / 1_000,
    );
  });
});
