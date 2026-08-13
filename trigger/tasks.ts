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

export const reconcileInboundMailboxesTask = schedules.task({
  id: "reconcile-inbound-mailboxes",
  cron: "* * * * *",
  ttl: "5m",
  retry: {
    ...WORKFLOW_TASKS["reconcile-inbound-mailboxes"].retry,
    factor: 2,
    randomize: true,
  },
  maxDuration: WORKFLOW_TASKS["reconcile-inbound-mailboxes"].maxDuration,
  run: (payload, { ctx }) =>
    runtime().execute(
      "reconcile-inbound-mailboxes",
      { observedAt: payload.timestamp.toISOString(), limit: 50 },
      { runId: ctx.run.id, attempt: ctx.attempt.number },
    ),
});

export const reconcileDueFollowUpsTask = schedules.task({
  id: "reconcile-due-follow-ups",
  cron: "* * * * *",
  ttl: "5m",
  retry: {
    ...WORKFLOW_TASKS["reconcile-due-follow-ups"].retry,
    factor: 2,
    randomize: true,
  },
  maxDuration: WORKFLOW_TASKS["reconcile-due-follow-ups"].maxDuration,
  run: (payload, { ctx }) =>
    runtime().execute(
      "reconcile-due-follow-ups",
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

export const recoverStaleWorkTask = schedules.task({
  id: "recover-stale-work",
  cron: "*/5 * * * *",
  ttl: "10m",
  retry: {
    ...WORKFLOW_TASKS["recover-stale-work"].retry,
    factor: 2,
    randomize: true,
  },
  maxDuration: WORKFLOW_TASKS["recover-stale-work"].maxDuration,
  run: (payload, { ctx }) =>
    runtime().execute(
      "recover-stale-work",
      { observedAt: payload.timestamp.toISOString() },
      { runId: ctx.run.id, attempt: ctx.attempt.number },
    ),
});
