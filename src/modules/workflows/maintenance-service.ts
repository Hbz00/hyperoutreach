import { randomUUID } from "node:crypto";

import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";

function minute(now: Date): string {
  return now.toISOString().slice(0, 16);
}

/**
 * Asks for one maintenance cycle.
 *
 * The key is per minute so a scheduler that fires twice inside one minute does
 * not stack two cycles. It was never the mutex — the `maintenance_state`
 * singleton lease is, and it returns `busy` to whoever loses. That leaves one
 * gap: a caller asking for a cycle *on demand* within a minute the scheduler
 * already used gets a silent no-op, which is indistinguishable from a cycle
 * that ran and did nothing. `immediate` is for that caller: it still competes
 * for the same lease, it simply is not deduplicated against the clock.
 */
export async function dispatchMaintenanceTick(
  dispatcher: WorkflowDispatcher,
  now: Date,
  options: { immediate?: boolean } = {},
) {
  const observedAt = now.toISOString();
  return [
    await dispatcher.dispatch({
      task: "maintenance-cycle",
      payload: { observedAt },
      idempotencyKey: options.immediate
        ? `maintenance:cycle:immediate:${randomUUID()}`
        : `maintenance:cycle:${minute(now)}`,
    }),
  ];
}
