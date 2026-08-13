import type { AppDatabase } from "@/lib/db/types";
import { executeAuditedWorkflow } from "@/modules/workflows/execution-audit";
import {
  parseWorkflowPayload,
  type WorkflowPayloads,
  type WorkflowTaskName,
} from "@/modules/workflows/task-contracts";

export type WorkflowRunContext = { runId: string; attempt: number };

export type WorkflowTaskServices = {
  [T in WorkflowTaskName]: (payload: WorkflowPayloads[T]) => Promise<unknown>;
};

function hasRetryableFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRetryableFailure);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.ok === false &&
    typeof record.code === "string" &&
    ["AGENT_ERROR", "DATABASE_ERROR", "PROVIDER_ERROR"].includes(record.code)
  ) {
    return true;
  }
  if (
    record.ok === true &&
    record.status === "provider_error" &&
    ["provider_transient_error", "mx_lookup_failure"].includes(
      String(record.reason),
    )
  ) {
    return true;
  }
  return Object.values(record).some(hasRetryableFailure);
}

function entityContext<T extends WorkflowTaskName>(
  task: T,
  payload: WorkflowPayloads[T],
): { entityType: string; entityId: string; logicalKey: string } {
  switch (task) {
    case "account-research": {
      const value = payload as WorkflowPayloads["account-research"];
      return {
        entityType: "account",
        entityId: value.accountId,
        logicalKey: `research:${value.accountId}:${value.force ? "forced" : "current"}`,
      };
    }
    case "contact-discovery": {
      const value = payload as WorkflowPayloads["contact-discovery"];
      return {
        entityType: "account",
        entityId: value.accountId,
        logicalKey: `contacts:${value.accountId}:${JSON.stringify(value.roles)}:${value.limit}`,
      };
    }
    case "email-resolution": {
      const value = payload as WorkflowPayloads["email-resolution"];
      return {
        entityType: "contact",
        entityId: value.contactId,
        logicalKey: `email-resolution:${value.contactId}`,
      };
    }
    case "generate-message": {
      const value = payload as WorkflowPayloads["generate-message"];
      return {
        entityType: "enrollment",
        entityId: value.enrollmentId,
        logicalKey: `generate:${value.enrollmentId}:${value.stepIndex}`,
      };
    }
    case "send-approved-message": {
      const value = payload as WorkflowPayloads["send-approved-message"];
      return {
        entityType: "message",
        entityId: value.messageId,
        logicalKey: `send:${value.messageId}`,
      };
    }
    case "advance-sequence": {
      const value = payload as WorkflowPayloads["advance-sequence"];
      return {
        entityType: "enrollment",
        entityId: value.enrollmentId,
        logicalKey: `followup:${value.enrollmentId}:${value.expectedToken}`,
      };
    }
    case "reconcile-inbound-mailbox": {
      const value = payload as WorkflowPayloads["reconcile-inbound-mailbox"];
      return {
        entityType: "mailbox",
        entityId: value.mailboxId,
        logicalKey: `inbound-mailbox:${value.mailboxId}:${new Date().toISOString().slice(0, 16)}`,
      };
    }
    case "personalize-message":
    case "account-discovery":
    case "reconcile-due-follow-ups":
    case "drain-graph-webhooks":
    case "reconcile-inbound-mailboxes":
    case "maintain-graph-subscriptions":
    case "recover-stale-work": {
      const observedAt =
        "observedAt" in payload && typeof payload.observedAt === "string"
          ? payload.observedAt
          : new Date().toISOString();
      return {
        entityType: "system",
        entityId: "00000000-0000-0000-0000-000000000000",
        logicalKey: `${task}:${observedAt}`,
      };
    }
  }
}

export class WorkflowRuntime {
  constructor(
    private readonly db: AppDatabase,
    private readonly services: WorkflowTaskServices,
  ) {}

  async execute<T extends WorkflowTaskName>(
    task: T,
    rawPayload: unknown,
    context: WorkflowRunContext,
  ): Promise<unknown> {
    const payload = parseWorkflowPayload(task, rawPayload);
    const entity = entityContext(task, payload);
    return executeAuditedWorkflow(
      this.db,
      {
        task,
        runId: context.runId,
        attempt: context.attempt,
        ...entity,
        payload: payload as Record<string, unknown>,
      },
      async () => {
        const result = await this.services[task](payload as never);
        if (hasRetryableFailure(result)) {
          throw new Error("Workflow service returned a retryable failure");
        }
        return result;
      },
    );
  }
}
