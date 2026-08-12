import { randomUUID } from "node:crypto";

import { and, eq, lt, or, sql } from "drizzle-orm";

import { workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";

import type {
  WorkflowDispatchRequest,
  WorkflowPayloads,
  WorkflowTaskName,
} from "@/modules/workflows/task-contracts";

export type WorkflowDispatchResult = { runId: string; duplicate: boolean };

export interface WorkflowDispatcher {
  dispatch<T extends WorkflowTaskName>(
    request: WorkflowDispatchRequest<T>,
  ): Promise<WorkflowDispatchResult>;
}

export type LocalWorkflowExecutor = <T extends WorkflowTaskName>(input: {
  task: T;
  payload: WorkflowPayloads[T];
  runId: string;
  attempt: number;
}) => Promise<unknown>;

export class TestWorkflowDispatcher implements WorkflowDispatcher {
  private readonly deliveries = new Map<
    string,
    { runId: string; execution: Promise<unknown> }
  >();

  constructor(
    private readonly execute: LocalWorkflowExecutor,
    private readonly createRunId: () => string = () => `local_${randomUUID()}`,
  ) {}

  async dispatch<T extends WorkflowTaskName>(
    request: WorkflowDispatchRequest<T>,
  ): Promise<WorkflowDispatchResult> {
    const key = `${request.task}\0${request.idempotencyKey}`;
    const existing = this.deliveries.get(key);
    if (existing) {
      await existing.execution;
      return { runId: existing.runId, duplicate: true };
    }
    const runId = this.createRunId();
    const execution = this.execute({
      task: request.task,
      payload: request.payload,
      runId,
      attempt: 1,
    });
    this.deliveries.set(key, { runId, execution });
    await execution;
    return { runId, duplicate: false };
  }
}

export class LocalWorkflowDispatcher implements WorkflowDispatcher {
  private readonly createRunId: () => string;
  private readonly clock: () => Date;
  private readonly leaseMs: number;

  constructor(
    private readonly db: AppDatabase,
    private readonly execute: LocalWorkflowExecutor,
    options:
      | (() => string)
      | {
          createRunId?: () => string;
          clock?: () => Date;
          leaseMs?: number;
        } = () => `local_${randomUUID()}`,
  ) {
    this.createRunId =
      typeof options === "function"
        ? options
        : (options.createRunId ?? (() => `local_${randomUUID()}`));
    this.clock =
      typeof options === "function"
        ? () => new Date()
        : (options.clock ?? (() => new Date()));
    this.leaseMs =
      typeof options === "function"
        ? 5 * 60_000
        : (options.leaseMs ?? 5 * 60_000);
  }

  async dispatch<T extends WorkflowTaskName>(
    request: WorkflowDispatchRequest<T>,
  ): Promise<WorkflowDispatchResult> {
    const persistedKey = `dispatcher:${request.task}:${request.idempotencyKey}`;
    const runId = this.createRunId();
    const now = this.clock();
    let [dispatchEvent] = await this.db
      .insert(workflowEvents)
      .values({
        entityType: "system",
        entityId: "00000000-0000-0000-0000-000000000000",
        event: `${request.task}.dispatched`,
        workflowName: request.task,
        runId,
        idempotencyKey: persistedKey,
        status: "started",
        scheduledAt: now,
        startedAt: now,
        payload: { input: request.payload },
      })
      .onConflictDoNothing()
      .returning({ id: workflowEvents.id, attempt: workflowEvents.attempt });
    if (!dispatchEvent) {
      const [prior] = await this.db
        .select({
          id: workflowEvents.id,
          runId: workflowEvents.runId,
          status: workflowEvents.status,
          attempt: workflowEvents.attempt,
          startedAt: workflowEvents.startedAt,
        })
        .from(workflowEvents)
        .where(eq(workflowEvents.idempotencyKey, persistedKey))
        .limit(1);
      const abandoned =
        prior?.status === "started" &&
        prior.startedAt !== null &&
        prior.startedAt < new Date(now.getTime() - this.leaseMs);
      if (!prior || (prior.status !== "failed" && !abandoned)) {
        return { runId: prior?.runId ?? runId, duplicate: true };
      }
      [dispatchEvent] = await this.db
        .update(workflowEvents)
        .set({
          runId,
          status: "started",
          attempt: sql`${workflowEvents.attempt} + 1`,
          startedAt: now,
          completedAt: null,
          error: null,
        })
        .where(
          and(
            eq(workflowEvents.id, prior.id),
            or(
              eq(workflowEvents.status, "failed"),
              and(
                eq(workflowEvents.status, "started"),
                lt(
                  workflowEvents.startedAt,
                  new Date(now.getTime() - this.leaseMs),
                ),
              ),
            ),
            eq(workflowEvents.attempt, prior.attempt),
          ),
        )
        .returning({ id: workflowEvents.id, attempt: workflowEvents.attempt });
      if (!dispatchEvent) {
        return { runId: prior.runId ?? runId, duplicate: true };
      }
    }
    const heartbeatInterval = setInterval(
      () => {
        void this.db
          .update(workflowEvents)
          .set({ startedAt: this.clock() })
          .where(
            and(
              eq(workflowEvents.id, dispatchEvent.id),
              eq(workflowEvents.runId, runId),
              eq(workflowEvents.status, "started"),
            ),
          )
          .catch(() => undefined);
      },
      Math.max(Math.floor(this.leaseMs / 3), 1_000),
    );
    heartbeatInterval.unref();
    try {
      const output = await this.execute({
        task: request.task,
        payload: request.payload,
        runId,
        attempt: dispatchEvent.attempt,
      });
      await this.db
        .update(workflowEvents)
        .set({
          status: "succeeded",
          completedAt: new Date(),
          payload: {
            input: request.payload,
            output: JSON.parse(JSON.stringify(output ?? null)),
          },
        })
        .where(
          and(
            eq(workflowEvents.id, dispatchEvent.id),
            eq(workflowEvents.runId, runId),
            eq(workflowEvents.status, "started"),
          ),
        );
      return { runId, duplicate: false };
    } catch {
      await this.db
        .update(workflowEvents)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: "Workflow task failed",
        })
        .where(
          and(
            eq(workflowEvents.id, dispatchEvent.id),
            eq(workflowEvents.runId, runId),
            eq(workflowEvents.status, "started"),
          ),
        );
      throw new Error("Workflow task failed");
    } finally {
      clearInterval(heartbeatInterval);
    }
  }
}

type TriggerDispatcherDependencies = {
  createGlobalIdempotencyKey: (
    key: string,
    options: { scope: "global" },
  ) => Promise<string>;
  trigger: (
    task: WorkflowTaskName,
    payload: WorkflowPayloads[WorkflowTaskName],
    options: { idempotencyKey: string },
  ) => Promise<{ id: string }>;
};

export class TriggerWorkflowDispatcher implements WorkflowDispatcher {
  constructor(private readonly dependencies: TriggerDispatcherDependencies) {}

  async dispatch<T extends WorkflowTaskName>(
    request: WorkflowDispatchRequest<T>,
  ): Promise<WorkflowDispatchResult> {
    const idempotencyKey = await this.dependencies.createGlobalIdempotencyKey(
      `${request.task}:${request.idempotencyKey}`,
      { scope: "global" },
    );
    const handle = await this.dependencies.trigger(
      request.task,
      request.payload,
      {
        idempotencyKey,
      },
    );
    return { runId: handle.id, duplicate: false };
  }
}
