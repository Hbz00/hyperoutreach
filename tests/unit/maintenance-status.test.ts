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

const NOW = new Date("2026-08-14T10:00:00.000Z");
const INTERVAL_MS = 60_000;
const CODEX_TIMEOUT_MS = 240_000;
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
      codeTimeoutMs: CODEX_TIMEOUT_MS,
      staleLeaseMs: STALE_LEASE_MS,
    },
  );
}

describe("maintenance status", () => {
  it("uses a five-minute overdue window for a 240-second Codex timeout", () => {
    expect(
      getMaintenanceOverdueWindowMs({
        intervalMs: INTERVAL_MS,
        codeTimeoutMs: CODEX_TIMEOUT_MS,
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
        OPENAI_PROVIDER: "invalid-ai-provider",
        WORKFLOW_PROVIDER: "trigger",
      }),
    ).toEqual({ provider: "Trigger.dev", mode: "Scheduled aggregate cycle" });
    expect(
      resolveMaintenanceAutomationPresentation({
        OPENAI_PROVIDER: "mock",
        WORKFLOW_PROVIDER: "invalid-workflow-provider",
      }),
    ).toEqual({ provider: "Misconfigured", mode: "Unavailable" });
  });

  it("uses the bounded provider parser and safely falls back to 240 seconds", () => {
    expect(getMaintenanceCodeTimeoutMs({ CODEX_TIMEOUT_MS: "360000" })).toBe(
      360_000,
    );
    expect(getMaintenanceCodeTimeoutMs({ CODEX_TIMEOUT_MS: "invalid" })).toBe(
      240_000,
    );
    expect(getMaintenanceCodeTimeoutMs({ CODEX_TIMEOUT_MS: "999999" })).toBe(
      240_000,
    );
    expect(
      getMaintenanceCodeTimeoutMs({
        CODEX_TIMEOUT_MS: "360000",
        CODEX_MAX_CONCURRENCY: "invalid unrelated value",
      }),
    ).toBe(360_000);
  });
});
