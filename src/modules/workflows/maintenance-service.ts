import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";

function minute(now: Date): string {
  return now.toISOString().slice(0, 16);
}

export async function dispatchMaintenanceTick(
  dispatcher: WorkflowDispatcher,
  now: Date,
) {
  const observedAt = now.toISOString();
  return [
    await dispatcher.dispatch({
      task: "maintenance-cycle",
      payload: { observedAt },
      idempotencyKey: `maintenance:cycle:${minute(now)}`,
    }),
  ];
}
