import type {
  InboundCursorEvents,
  InboundHealthOptions,
} from "@/modules/mailboxes/inbound-reconciliation";

/**
 * The single source of truth for Graph's historical inbound-reconciliation
 * literals. Two producers need these values — `reconcileGraphDelta` in
 * microsoft-graph-sync-service.ts (webhook/lifecycle/stale recovery keep
 * calling it directly) and the "reconcile-inbound-mailbox" task's registry
 * entry in inbound-source-bootstrap.ts (the generic per-mailbox dispatch) —
 * and one consumer reads them back: the send gate in send-service.ts, which
 * blocks sends while `workflowName: "graph_delta_health"` is unresolved.
 *
 * Deliberately a plain constants module: no registry, no side effect, no
 * `@/lib/microsoft/*` import. Either producer can depend on it without
 * coupling to the other's import order — importing `inbound-reconciliation`
 * here is safe because that module is itself side-effect free and already a
 * dependency of both producers.
 */
export const GRAPH_DELTA_HEALTH_WORKFLOW_NAME = "graph_delta_health";
export const GRAPH_DELTA_RECONCILIATION_WORKFLOW_NAME =
  "graph_delta_reconciliation";
export const GRAPH_DELTA_FAILED_EVENT = "graph.delta_failed";
export const GRAPH_DELTA_SYNCED_EVENT = "graph.delta_synced";
export const GRAPH_DELTA_REBASELINED_EVENT = "graph.delta_rebaselined";
export const GRAPH_DELTA_FAILURE_ERROR =
  "Microsoft Graph delta reconciliation failed";

export function graphDeltaLockKey(mailboxId: string): string {
  return `microsoft-graph-delta:${mailboxId}`;
}

export function graphDeltaHealthKey(mailboxId: string): string {
  return `graph:delta-health:${mailboxId}`;
}

export function graphDeltaHealthOptions(
  mailboxId: string,
): InboundHealthOptions {
  return {
    lockKey: graphDeltaLockKey(mailboxId),
    healthKey: graphDeltaHealthKey(mailboxId),
    event: GRAPH_DELTA_FAILED_EVENT,
    workflowName: GRAPH_DELTA_HEALTH_WORKFLOW_NAME,
    failureError: GRAPH_DELTA_FAILURE_ERROR,
  };
}

export function graphDeltaCursorEvents(): InboundCursorEvents {
  return {
    synced: GRAPH_DELTA_SYNCED_EVENT,
    rebaselined: GRAPH_DELTA_REBASELINED_EVENT,
    workflowName: GRAPH_DELTA_RECONCILIATION_WORKFLOW_NAME,
  };
}
