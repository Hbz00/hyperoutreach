import {
  GraphRetryDeferredError,
  graphRetryNotBefore,
  recordGraphRetry,
} from "@/lib/microsoft/graph-retry";
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
 * Both producers also receive the same durable provider-retry hooks here.
 * Importing this module registers nothing and performs no database I/O;
 * the hooks use the database supplied by the active reconciliation round.
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
    retry: {
      notBefore: (db) => graphRetryNotBefore(db, mailboxId),
      deferredError: (deadline) => new GraphRetryDeferredError(deadline),
      recordFailure: (db, error, now, policyDelayMs) =>
        recordGraphRetry(db, mailboxId, error, now, policyDelayMs),
    },
  };
}

export function graphDeltaCursorEvents(): InboundCursorEvents {
  return {
    synced: GRAPH_DELTA_SYNCED_EVENT,
    rebaselined: GRAPH_DELTA_REBASELINED_EVENT,
    workflowName: GRAPH_DELTA_RECONCILIATION_WORKFLOW_NAME,
  };
}
