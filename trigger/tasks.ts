import { schedules, task } from "@trigger.dev/sdk";

import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import { WorkflowRuntime } from "@/modules/workflows/runtime";
import {
  WORKFLOW_TASKS,
  type WorkflowPayloads,
  type WorkflowTaskName,
} from "@/modules/workflows/task-contracts";
import { getDatabase } from "@/lib/db/client-core";

function runtime() {
  const db = getDatabase();
  return new WorkflowRuntime(db, createWorkflowTaskServices(db));
}

function regularTask<T extends WorkflowTaskName>(id: T) {
  const definition = WORKFLOW_TASKS[id];
  return task({
    id,
    retry: { ...definition.retry, factor: 2, randomize: true },
    maxDuration: definition.maxDuration,
    run: (payload: WorkflowPayloads[T], { ctx }) =>
      runtime().execute(id, payload, {
        runId: ctx.run.id,
        attempt: ctx.attempt.number,
      }),
  });
}

export const accountDiscoveryTask = regularTask("account-discovery");
export const accountResearchTask = regularTask("account-research");
export const contactDiscoveryTask = regularTask("contact-discovery");
export const emailResolutionTask = regularTask("email-resolution");
export const personalizeMessageTask = regularTask("personalize-message");
export const generateMessageTask = regularTask("generate-message");
export const sendApprovedMessageTask = regularTask("send-approved-message");
export const advanceSequenceTask = regularTask("advance-sequence");
export const drainGraphWebhooksTask = regularTask("drain-graph-webhooks");
export const reconcileInboundMailboxTask = regularTask(
  "reconcile-inbound-mailbox",
);
export const reconcileInboundMailboxesTask = regularTask(
  "reconcile-inbound-mailboxes",
);
export const reconcileDueFollowUpsTask = regularTask(
  "reconcile-due-follow-ups",
);
export const recoverStaleWorkTask = regularTask("recover-stale-work");

export const maintenanceCycleTask = schedules.task({
  id: "maintenance-cycle",
  cron: "* * * * *",
  ttl: "15m",
  retry: {
    ...WORKFLOW_TASKS["maintenance-cycle"].retry,
    factor: 2,
    randomize: true,
  },
  maxDuration: WORKFLOW_TASKS["maintenance-cycle"].maxDuration,
  run: (payload, { ctx }) =>
    runtime().execute(
      "maintenance-cycle",
      { observedAt: payload.timestamp.toISOString() },
      { runId: ctx.run.id, attempt: ctx.attempt.number },
    ),
});

export const maintainGraphSubscriptionsTask = schedules.task({
  id: "maintain-graph-subscriptions",
  cron: "*/5 * * * *",
  ttl: "10m",
  retry: {
    ...WORKFLOW_TASKS["maintain-graph-subscriptions"].retry,
    factor: 2,
    randomize: true,
  },
  maxDuration: WORKFLOW_TASKS["maintain-graph-subscriptions"].maxDuration,
  run: (payload, { ctx }) =>
    runtime().execute(
      "maintain-graph-subscriptions",
      { observedAt: payload.timestamp.toISOString() },
      { runId: ctx.run.id, attempt: ctx.attempt.number },
    ),
});
