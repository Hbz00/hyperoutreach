import "server-only";

import { idempotencyKeys, tasks } from "@trigger.dev/sdk";

import { getDatabase } from "@/lib/db/client";
import {
  LocalWorkflowDispatcher,
  TriggerWorkflowDispatcher,
  type WorkflowDispatcher,
} from "@/modules/workflows/dispatcher";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import { WorkflowRuntime } from "@/modules/workflows/runtime";

export function createWorkflowDispatcher(
  environment: Record<string, string | undefined> = process.env,
): WorkflowDispatcher {
  if (environment.WORKFLOW_PROVIDER === "trigger") {
    if (!environment.TRIGGER_SECRET_KEY?.trim()) {
      throw new Error(
        "TRIGGER_SECRET_KEY is required when WORKFLOW_PROVIDER=trigger",
      );
    }
    return new TriggerWorkflowDispatcher({
      createGlobalIdempotencyKey: (key, options) =>
        idempotencyKeys.create(key, options),
      trigger: (task, payload, options) =>
        tasks.trigger(task, payload, options),
    });
  }
  const db = getDatabase();
  const runtime = new WorkflowRuntime(
    db,
    createWorkflowTaskServices(db, environment),
  );
  return new LocalWorkflowDispatcher(db, (input) =>
    runtime.execute(input.task, input.payload, {
      runId: input.runId,
      attempt: input.attempt,
    }),
  );
}
