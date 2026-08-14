import { and, eq } from "drizzle-orm";

import { workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { getSafeWorkflowAuditError } from "@/modules/workflows/maintenance-error";
import type { WorkflowTaskName } from "@/modules/workflows/task-contracts";

type ExecutionContext = {
  task: WorkflowTaskName;
  runId: string;
  attempt: number;
  entityType: string;
  entityId: string;
  logicalKey: string;
  payload: Record<string, unknown>;
};

function recordValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export async function executeAuditedWorkflow<T>(
  db: AppDatabase,
  context: ExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  const idempotencyKey = `${context.logicalKey}:executor:${context.runId}:attempt:${context.attempt}`;
  const startedAt = new Date();
  const [created] = await db
    .insert(workflowEvents)
    .values({
      entityType: context.entityType,
      entityId: context.entityId,
      event: `${context.task}.attempt`,
      workflowName: context.task,
      runId: context.runId,
      idempotencyKey,
      status: "started",
      attempt: context.attempt,
      startedAt,
      payload: {
        logicalKey: context.logicalKey,
        input: recordValue(context.payload),
      },
    })
    .onConflictDoNothing()
    .returning({ id: workflowEvents.id });
  if (!created) {
    const [prior] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.idempotencyKey, idempotencyKey),
          eq(workflowEvents.runId, context.runId),
        ),
      )
      .limit(1);
    if (prior?.status === "succeeded") {
      return (prior.payload as { output: T }).output;
    }
    throw new Error("Workflow attempt already active");
  }
  try {
    const output = await operation();
    await db
      .update(workflowEvents)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        payload: {
          logicalKey: context.logicalKey,
          input: recordValue(context.payload),
          output: recordValue(output),
        },
      })
      .where(eq(workflowEvents.id, created.id));
    return output;
  } catch (error) {
    await db
      .update(workflowEvents)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: getSafeWorkflowAuditError(error),
      })
      .where(eq(workflowEvents.id, created.id));
    throw new Error("Workflow task failed");
  }
}
