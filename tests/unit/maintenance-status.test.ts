import { describe, expect, it } from "vitest";

import {
  getMaintenanceOverdueWindowMs,
  resolveMaintenanceStatus,
  type MaintenanceStatusProjection,
} from "@/modules/workflows/maintenance-status";
import {
  getMaintenanceAutomationPresentation,
  getMaintenanceCodeTimeoutMs,
  getMaintenanceStatusPresentation,
  resolveMaintenanceAutomationPresentation,
} from "@/modules/workflows/maintenance-status-presentation";
import maintenanceConfig from "../../config/maintenance.json";

const NOW = new Date("2026-08-14T10:00:00.000Z");
const INTERVAL_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 240_000;
const STALE_LEASE_MS = 120_000;

const emptyProjection = (): MaintenanceStatusProjection => ({
  ownerToken: null,
  cycleStartedAt: null,
  heartbeatAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
});

function resolve(projection: Partial<MaintenanceStatusProjection>) {
  return resolveMaintenanceStatus(
    { ...emptyProjection(), ...projection },
    {
      now: NOW,
      intervalMs: INTERVAL_MS,
      codeTimeoutMs: RESEARCH_TIMEOUT_MS,
      staleLeaseMs: STALE_LEASE_MS,
    },
  );
}

describe("maintenance status", () => {
  it("uses a five-minute overdue window for a 240-second research timeout", () => {
    expect(
      getMaintenanceOverdueWindowMs({
        intervalMs: INTERVAL_MS,
        codeTimeoutMs: RESEARCH_TIMEOUT_MS,
      }),
    ).toBe(300_000);
  });

  it("reports not_started when no cycle has ever started", () => {
    expect(resolve({}).state).toBe("not_started");
  });

  it("reports running while an owner has a fresh heartbeat", () => {
    expect(
      resolve({
        ownerToken: "worker-1",
        cycleStartedAt: new Date("2026-08-14T09:56:00.000Z"),
        heartbeatAt: new Date("2026-08-14T09:59:30.000Z"),
        lastFailedAt: new Date("2026-08-14T09:59:50.000Z"),
      }).state,
    ).toBe("running");
  });

  /**
   * A heartbeat proves the process is alive, not that the work is moving.
   *
   * Observed in production: an inbound stage ran for twenty-eight minutes while
   * its heartbeat renewed every thirty seconds, so this function answered
   * `running` the whole time and the operator's screen said the same. Every
   * stage now has a deadline, which makes a cycle longer than the sum of those
   * deadlines impossible by construction — so when one is seen, it is stuck,
   * and saying `running` is the one answer that cannot be true.
   */
  it("reports stalled when a fresh-heartbeat cycle outlives every stage budget", () => {
    expect(
      resolve({
        ownerToken: "owner",
        // Older than the total of the stage budgets plus the margin.
        cycleStartedAt: new Date(NOW.getTime() - 30 * 60_000),
        heartbeatAt: new Date(NOW.getTime() - 5_000),
      }).state,
    ).toBe("stalled");
  });

  it("still reports running for a long cycle inside its budget", () => {
    expect(
      resolve({
        ownerToken: "owner",
        cycleStartedAt: new Date(NOW.getTime() - 60_000),
        heartbeatAt: new Date(NOW.getTime() - 5_000),
      }).state,
    ).toBe("running");
  });

  it("reports stalled when an owner heartbeat is stale", () => {
    expect(
      resolve({
        ownerToken: "worker-1",
        cycleStartedAt: new Date("2026-08-14T09:56:00.000Z"),
        heartbeatAt: new Date("2026-08-14T09:57:59.999Z"),
      }).state,
    ).toBe("stalled");
  });

  it("reports failed when the latest failure is newer than the latest success", () => {
    expect(
      resolve({
        lastSucceededAt: new Date("2026-08-14T09:50:00.000Z"),
        lastFailedAt: new Date("2026-08-14T09:51:00.000Z"),
        lastError: "Inbound reconciliation failed",
      }).state,
    ).toBe("failed");
  });

  it("reports overdue when the latest success is outside the allowed window", () => {
    expect(
      resolve({
        lastSucceededAt: new Date("2026-08-14T09:54:59.999Z"),
        lastFailedAt: new Date("2026-08-14T09:54:00.000Z"),
      }).state,
    ).toBe("overdue");
  });

  it("reports healthy when the latest success is within the allowed window", () => {
    expect(
      resolve({
        lastSucceededAt: new Date("2026-08-14T09:55:00.000Z"),
        lastFailedAt: new Date("2026-08-14T09:54:00.000Z"),
      }).state,
    ).toBe("healthy");
  });
});

describe("maintenance status presentation", () => {
  it.each([
    ["not_started", "Not started"],
    ["running", "Running"],
    ["stalled", "Stalled"],
    ["failed", "Failed"],
    ["overdue", "Overdue"],
    ["healthy", "Healthy"],
  ] as const)("presents %s as %s", (state, label) => {
    const presentation = getMaintenanceStatusPresentation(state);

    expect(presentation.label).toBe(label);
    expect(presentation.detail.length).toBeGreaterThan(20);
  });

  it("describes automatic local, disabled local, and Trigger ownership", () => {
    expect(
      getMaintenanceAutomationPresentation({
        workflowProvider: "local",
        localMaintenanceEnabled: true,
      }),
    ).toEqual({ provider: "Local", mode: "Automatic worker" });
    expect(
      getMaintenanceAutomationPresentation({
        workflowProvider: "local",
        localMaintenanceEnabled: false,
      }),
    ).toEqual({ provider: "Local", mode: "Disabled by configuration" });
    expect(
      getMaintenanceAutomationPresentation({
        workflowProvider: "trigger",
        localMaintenanceEnabled: false,
      }),
    ).toEqual({ provider: "Trigger.dev", mode: "Scheduled aggregate cycle" });
    expect(
      getMaintenanceAutomationPresentation({
        workflowProvider: "misconfigured",
        localMaintenanceEnabled: true,
      }),
    ).toEqual({ provider: "Misconfigured", mode: "Unavailable" });
  });

  it("resolves workflow ownership independently from invalid AI configuration", () => {
    expect(
      resolveMaintenanceAutomationPresentation({
        AI_PROVIDER: "invalid-ai-provider",
        WORKFLOW_PROVIDER: "trigger",
      }),
    ).toEqual({ provider: "Trigger.dev", mode: "Scheduled aggregate cycle" });
    expect(
      resolveMaintenanceAutomationPresentation({
        AI_PROVIDER: "mock",
        WORKFLOW_PROVIDER: "invalid-workflow-provider",
      }),
    ).toEqual({ provider: "Misconfigured", mode: "Unavailable" });
  });

  it("uses the bounded provider parser and safely falls back to 600 seconds", () => {
    expect(
      getMaintenanceCodeTimeoutMs({ AI_RESEARCH_TIMEOUT_MS: "360000" }),
    ).toBe(360_000);
    expect(
      getMaintenanceCodeTimeoutMs({ AI_RESEARCH_TIMEOUT_MS: "invalid" }),
    ).toBe(600_000);
    expect(
      getMaintenanceCodeTimeoutMs({ AI_RESEARCH_TIMEOUT_MS: "999999" }),
    ).toBe(600_000);
    expect(
      getMaintenanceCodeTimeoutMs({
        AI_RESEARCH_TIMEOUT_MS: "360000",
        AI_FAST_TIMEOUT_MS: "invalid unrelated value",
      }),
    ).toBe(360_000);
  });
});

/**
 * The budget table has to agree with the work it wraps, and with itself.
 *
 * Two relations no type can hold. The command stage wraps at most one AI turn —
 * the drain stops after the first — so its deadline has to be strictly longer
 * than that turn's own: set equal, the two race, and a research call that ran
 * out its own timeout is recorded as a maintenance failure rather than as the
 * refusal it is. And the aggregate the local worker waits on has to hold every
 * stage plus one transport margin, or the HTTP request gives up on a cycle that
 * was still inside the budget it was given.
 */
describe("the maintenance budget table", () => {
  const stages = maintenanceConfig.stageMaximumsMs;

  it("gives the command stage more room than the AI turn it wraps", () => {
    expect(stages.commands).toBeGreaterThan(getMaintenanceCodeTimeoutMs({}));
  });

  it("holds every stage and the transport margin inside the aggregate", () => {
    const total =
      stages.inbound + stages.followups + stages.recovery + stages.commands;
    expect(total + maintenanceConfig.transportMarginMs).toBe(
      maintenanceConfig.aggregateBudgetMs,
    );
  });
});
