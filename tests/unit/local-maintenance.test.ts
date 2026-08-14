import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import maintenanceConfig from "../../config/maintenance.json";
import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";
import { dispatchMaintenanceTick } from "@/modules/workflows/maintenance-service";

function recordingDispatcher() {
  const dispatch = vi.fn(async (request) => ({
    runId: `run-${request.task}`,
    duplicate: false,
  }));
  return {
    dispatcher: { dispatch } as unknown as WorkflowDispatcher,
    dispatch,
  };
}

describe("self-hosted maintenance tick", () => {
  const now = new Date("2026-08-14T10:42:59.999Z");

  it("dispatches the database-owned aggregate maintenance cycle", async () => {
    const { dispatcher, dispatch } = recordingDispatcher();

    await dispatchMaintenanceTick(dispatcher, now);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      task: "maintenance-cycle",
      payload: { observedAt: now.toISOString() },
      idempotencyKey: "maintenance:cycle:2026-08-14T10:42",
    });
  });

  it("keeps the statically analyzable route duration aligned with shared config", () => {
    const routeSource = readFileSync(
      "src/app/api/internal/workflows/reconcile/route.ts",
      "utf8",
    );
    const literal = routeSource.match(/export const maxDuration = (\d+);/)?.[1];

    expect(literal).toBeDefined();
    expect(Number(literal) * 1_000).toBe(maintenanceConfig.aggregateBudgetMs);
  });

  it("keeps minute idempotency stable without treating it as the mutex", async () => {
    const { dispatcher, dispatch } = recordingDispatcher();

    await dispatchMaintenanceTick(dispatcher, now);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "maintenance-cycle",
        idempotencyKey: "maintenance:cycle:2026-08-14T10:42",
      }),
    );
  });
});
