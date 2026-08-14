import { describe, expect, it, vi } from "vitest";

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

  it("synchronizes SMTP/IMAP replies before due follow-ups and stale recovery", async () => {
    const { dispatcher, dispatch } = recordingDispatcher();

    await dispatchMaintenanceTick(dispatcher, "local", now);

    expect(dispatch.mock.calls.map(([request]) => request.task)).toEqual([
      "reconcile-inbound-mailboxes",
      "reconcile-due-follow-ups",
      "recover-stale-work",
    ]);
    expect(
      dispatch.mock.calls.map(([request]) => request.idempotencyKey),
    ).toEqual([
      "maintenance:inbound:2026-08-14T10:42",
      "maintenance:followups:2026-08-14T10:42",
      "recovery:2026-08-14T10:42",
    ]);
  });

  it("leaves Trigger cron ownership unchanged", async () => {
    const { dispatcher, dispatch } = recordingDispatcher();

    await dispatchMaintenanceTick(dispatcher, "trigger", now);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "recover-stale-work",
        idempotencyKey: "recovery:2026-08-14T10:42",
      }),
    );
  });
});
