import type { WorkflowDispatcher } from "@/modules/workflows/dispatcher";
import type { WorkflowProvider } from "@/modules/workflows/provider-config";
import { recoveryDispatchKey } from "@/modules/workflows/recovery-service";

function minute(now: Date): string {
  return now.toISOString().slice(0, 16);
}

export async function dispatchMaintenanceTick(
  dispatcher: WorkflowDispatcher,
  provider: WorkflowProvider,
  now: Date,
) {
  const observedAt = now.toISOString();
  const outcomes = [];
  if (provider === "local") {
    outcomes.push(
      await dispatcher.dispatch({
        task: "reconcile-inbound-mailboxes",
        payload: { observedAt },
        idempotencyKey: `maintenance:inbound:${minute(now)}`,
      }),
    );
    outcomes.push(
      await dispatcher.dispatch({
        task: "reconcile-due-follow-ups",
        payload: { observedAt },
        idempotencyKey: `maintenance:followups:${minute(now)}`,
      }),
    );
  }
  outcomes.push(
    await dispatcher.dispatch({
      task: "recover-stale-work",
      payload: { observedAt },
      idempotencyKey: recoveryDispatchKey(now),
    }),
  );
  return outcomes;
}
