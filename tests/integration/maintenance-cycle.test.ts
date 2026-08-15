import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { AppDatabase } from "@/lib/db/types";
import {
  defaultInboundCursorEvents,
  defaultInboundNaming,
} from "@/modules/mailboxes/inbound-reconciliation";
import {
  registerInboundProvider,
  resolveInboundProvider,
} from "@/modules/mailboxes/inbound-source-registry";
import { LocalWorkflowDispatcher } from "@/modules/workflows/dispatcher";
import {
  runMaintenanceCycle,
  type MaintenanceCycleStages,
} from "@/modules/workflows/maintenance-cycle-service";
import { dispatchMaintenanceTick } from "@/modules/workflows/maintenance-service";
import { resolveMaintenanceStatus } from "@/modules/workflows/maintenance-status";
import {
  WorkflowRuntime,
  type WorkflowTaskServices,
} from "@/modules/workflows/runtime";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import { WORKFLOW_TASKS } from "@/modules/workflows/task-contracts";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 8 });
const db = drizzle(client, { schema });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledHeartbeatDatabase(gate: Promise<void>): {
  db: AppDatabase;
  heartbeatStarted: Promise<void>;
  concurrency: () => { active: number; maximum: number };
} {
  const started = deferred();
  let active = 0;
  let maximum = 0;
  const update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        const execute = async () => {
          if (
            "heartbeatAt" in values &&
            !("ownerToken" in values) &&
            !("lastFailedAt" in values)
          ) {
            active += 1;
            maximum = Math.max(maximum, active);
            started.resolve();
            await gate;
            active -= 1;
          }
          return [{ id: 1 }];
        };
        return {
          returning: execute,
          then: <TResult1 = unknown, TResult2 = never>(
            onfulfilled?:
              ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?:
              ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => execute().then(onfulfilled, onrejected),
        };
      },
    }),
  }));
  return {
    db: { update } as unknown as AppDatabase,
    heartbeatStarted: started.promise,
    concurrency: () => ({ active, maximum }),
  };
}

function stages(
  overrides: Partial<MaintenanceCycleStages> = {},
): MaintenanceCycleStages {
  return {
    "reconcile-inbound-mailboxes": vi.fn(async () => ({ processed: 0 })),
    "reconcile-due-follow-ups": vi.fn(async () => []),
    "recover-stale-work": vi.fn(async () => ({ recovered: 0 })),
    ...overrides,
  };
}

function workflowServices(
  maintenanceStages: MaintenanceCycleStages,
): WorkflowTaskServices {
  const services = Object.fromEntries(
    Object.keys(WORKFLOW_TASKS).map((task) => [
      task,
      async () => ({ ok: true, task }),
    ]),
  ) as unknown as WorkflowTaskServices;
  services["maintenance-cycle"] = (payload) =>
    runMaintenanceCycle(db, maintenanceStages, payload, {
      clock: () => new Date(payload.observedAt ?? "2026-08-14T10:42:00.000Z"),
      createOwnerToken: () => "restart-owner",
      heartbeatMs: 60_000,
      leaseStaleMs: 120_000,
    });
  return services;
}

async function projection() {
  const [row] = await db
    .select()
    .from(schema.maintenanceState)
    .where(eq(schema.maintenanceState.id, 1));
  if (!row) throw new Error("maintenance projection missing");
  return row;
}

describe("aggregate maintenance dispatch", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await db.delete(schema.workflowEvents);
    await db
      .update(schema.maintenanceState)
      .set({
        ownerToken: null,
        cycleStartedAt: null,
        heartbeatAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        updatedAt: new Date("2026-08-14T09:00:00.000Z"),
      })
      .where(eq(schema.maintenanceState.id, 1));
  });

  afterAll(async () => {
    await client.end();
  });

  it("dispatches one minute-scoped aggregate cycle instead of independent stages", async () => {
    const dispatch = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const now = new Date("2026-08-14T10:42:59.999Z");

    await dispatchMaintenanceTick({ dispatch }, now);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      task: "maintenance-cycle",
      payload: { observedAt: now.toISOString() },
      idempotencyKey: "maintenance:cycle:2026-08-14T10:42",
    });
  });

  it("allows one owner across concurrent callers with different minute keys", async () => {
    const inboundStarted = deferred();
    const releaseInbound = deferred();
    const firstStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        inboundStarted.resolve();
        await releaseInbound.promise;
        return { processed: 0 };
      }),
    });
    const secondStages = stages();
    const first = runMaintenanceCycle(
      db,
      firstStages,
      { observedAt: "2026-08-14T10:42:00.000Z" },
      {
        clock: () => new Date("2026-08-14T10:42:00.000Z"),
        createOwnerToken: () => "owner-first",
        heartbeatMs: 60_000,
        leaseStaleMs: 120_000,
      },
    );
    await inboundStarted.promise;

    await expect(
      runMaintenanceCycle(
        db,
        secondStages,
        { observedAt: "2026-08-14T10:43:00.000Z" },
        {
          clock: () => new Date("2026-08-14T10:43:00.000Z"),
          createOwnerToken: () => "owner-second",
          heartbeatMs: 60_000,
          leaseStaleMs: 120_000,
        },
      ),
    ).resolves.toEqual({ status: "busy" });
    expect(secondStages["reconcile-inbound-mailboxes"]).not.toHaveBeenCalled();
    expect(secondStages["reconcile-due-follow-ups"]).not.toHaveBeenCalled();
    expect(secondStages["recover-stale-work"]).not.toHaveBeenCalled();

    releaseInbound.resolve();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
  });

  it("reconciles every available non-mock mailbox, including Graph, before followups", async () => {
    const originalGraph = resolveInboundProvider("microsoft_graph");
    const order: string[] = [];
    registerInboundProvider("microsoft_graph", {
      createSource: () => ({
        kind: "microsoft_graph",
        async fetchSince(cursor) {
          order.push("graph");
          return { nextCursor: cursor ?? "graph-cursor", rebaselined: false };
        },
      }),
      naming: (mailboxId) => defaultInboundNaming("microsoft_graph", mailboxId),
      cursorEvents: () => defaultInboundCursorEvents("microsoft_graph"),
    });
    const address = `graph-maintenance-${crypto.randomUUID()}@example.com`;
    const [mailbox] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "microsoft_graph",
        email: address,
        normalizedEmail: address,
        status: "available",
        syncCursor: "graph-cursor",
        lastSyncedAt: new Date("2026-08-14T10:00:00.000Z"),
      })
      .returning();
    if (!mailbox) throw new Error("Graph mailbox fixture missing");
    try {
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
      });
      services["reconcile-due-follow-ups"] = vi.fn(async () => {
        order.push("followups");
        return [];
      });
      services["recover-stale-work"] = vi.fn(async () => {
        order.push("recovery");
        return { recovered: 0 };
      });

      await expect(
        services["maintenance-cycle"]({
          observedAt: "2026-08-14T10:42:00.000Z",
        }),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(order).toEqual(["graph", "followups", "recovery"]);
    } finally {
      registerInboundProvider("microsoft_graph", originalGraph);
      await db
        .delete(schema.mailboxConnections)
        .where(eq(schema.mailboxConnections.id, mailbox.id));
    }
  });

  it("reconciles more than fifty available mailboxes before aggregate followups when no limit is supplied", async () => {
    const originalGraph = resolveInboundProvider("microsoft_graph");
    const order: string[] = [];
    registerInboundProvider("microsoft_graph", {
      createSource: (_db, mailbox) => ({
        kind: "microsoft_graph",
        async fetchSince(cursor) {
          order.push(mailbox.id);
          return { nextCursor: cursor ?? mailbox.id, rebaselined: false };
        },
      }),
      naming: (mailboxId) => defaultInboundNaming("microsoft_graph", mailboxId),
      cursorEvents: () => defaultInboundCursorEvents("microsoft_graph"),
    });
    const fixturePrefix = `exhaustive-${crypto.randomUUID()}`;
    const created = await db
      .insert(schema.mailboxConnections)
      .values(
        Array.from({ length: 51 }, (_, index) => {
          const address = `${fixturePrefix}-${index}@example.com`;
          return {
            provider: "microsoft_graph" as const,
            email: address,
            normalizedEmail: address,
            status: "available" as const,
            syncCursor: `cursor-${index}`,
            lastSyncedAt: new Date("2026-08-14T10:00:00.000Z"),
          };
        }),
      )
      .returning({ id: schema.mailboxConnections.id });
    try {
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
      });
      services["reconcile-due-follow-ups"] = vi.fn(async () => {
        order.push("followups");
        return [];
      });
      services["recover-stale-work"] = vi.fn(async () => {
        order.push("recovery");
        return { recovered: 0 };
      });

      const outcome = (await services["maintenance-cycle"]({
        observedAt: "2026-08-14T10:42:00.000Z",
      })) as
        | { status: "busy" }
        | {
            status: "succeeded";
            stages: { inbound: unknown; followups: unknown; recovery: unknown };
          };
      expect(outcome).toMatchObject({ status: "succeeded" });
      if (outcome.status !== "succeeded") {
        throw new Error("Maintenance fixture did not complete");
      }

      const reconciled = order.slice(0, -2);
      expect(reconciled).toHaveLength(51);
      expect(new Set(reconciled)).toEqual(
        new Set(created.map((row) => row.id)),
      );
      expect(
        (
          outcome.stages.inbound as {
            results: Array<{ mailboxId: string }>;
          }
        ).results.map((result) => result.mailboxId),
      ).toEqual(created.map((row) => row.id).sort());
      expect(order.slice(-2)).toEqual(["followups", "recovery"]);
    } finally {
      registerInboundProvider("microsoft_graph", originalGraph);
      await db.delete(schema.mailboxConnections).where(
        inArray(
          schema.mailboxConnections.id,
          created.map((row) => row.id),
        ),
      );
    }
  });

  it("lets later mailboxes progress behind a slow mailbox and still waits before followups", async () => {
    const originalGraph = resolveInboundProvider("microsoft_graph");
    const slowStarted = deferred();
    const releaseSlow = deferred();
    const laterStarted = deferred();
    const order: string[] = [];
    let slowMailboxId = "";
    registerInboundProvider("microsoft_graph", {
      createSource: (_db, mailbox) => ({
        kind: "microsoft_graph",
        async fetchSince(cursor) {
          order.push(`started:${mailbox.id}`);
          if (mailbox.id === slowMailboxId) {
            slowStarted.resolve();
            await releaseSlow.promise;
          } else {
            laterStarted.resolve();
          }
          order.push(`finished:${mailbox.id}`);
          return { nextCursor: cursor ?? mailbox.id, rebaselined: false };
        },
      }),
      naming: (mailboxId) => defaultInboundNaming("microsoft_graph", mailboxId),
      cursorEvents: () => defaultInboundCursorEvents("microsoft_graph"),
    });
    const fixturePrefix = `concurrent-${crypto.randomUUID()}`;
    const created = await db
      .insert(schema.mailboxConnections)
      .values(
        Array.from({ length: 4 }, (_, index) => {
          const address = `${fixturePrefix}-${index}@example.com`;
          return {
            provider: "microsoft_graph" as const,
            email: address,
            normalizedEmail: address,
            status: "available" as const,
            syncCursor: `cursor-${index}`,
            lastSyncedAt: new Date("2026-08-14T10:00:00.000Z"),
          };
        }),
      )
      .returning({ id: schema.mailboxConnections.id });
    const sortedIds = created.map((row) => row.id).sort();
    slowMailboxId = sortedIds[0] ?? "";
    try {
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
      });
      services["reconcile-due-follow-ups"] = vi.fn(async () => {
        order.push("followups");
        return [];
      });
      services["recover-stale-work"] = vi.fn(async () => {
        order.push("recovery");
        return { recovered: 0 };
      });

      const cycle = services["maintenance-cycle"]({
        observedAt: "2026-08-14T10:42:00.000Z",
      });
      await slowStarted.promise;
      await expect(
        Promise.race([
          laterStarted.promise.then(() => "later-started"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("timed-out"), 100),
          ),
        ]),
      ).resolves.toBe("later-started");
      expect(order).not.toContain("followups");

      releaseSlow.resolve();
      await expect(cycle).resolves.toMatchObject({ status: "succeeded" });
      expect(order.slice(-2)).toEqual(["followups", "recovery"]);
    } finally {
      releaseSlow.resolve();
      registerInboundProvider("microsoft_graph", originalGraph);
      await db.delete(schema.mailboxConnections).where(
        inArray(
          schema.mailboxConnections.id,
          created.map((row) => row.id),
        ),
      );
    }
  });

  it("honors an explicit limit for the narrow inbound mailbox task", async () => {
    const originalGraph = resolveInboundProvider("microsoft_graph");
    const reconciled: string[] = [];
    registerInboundProvider("microsoft_graph", {
      createSource: (_db, mailbox) => ({
        kind: "microsoft_graph",
        async fetchSince(cursor) {
          reconciled.push(mailbox.id);
          return { nextCursor: cursor ?? mailbox.id, rebaselined: false };
        },
      }),
      naming: (mailboxId) => defaultInboundNaming("microsoft_graph", mailboxId),
      cursorEvents: () => defaultInboundCursorEvents("microsoft_graph"),
    });
    const fixturePrefix = `bounded-${crypto.randomUUID()}`;
    const created = await db
      .insert(schema.mailboxConnections)
      .values(
        Array.from({ length: 12 }, (_, index) => {
          const address = `${fixturePrefix}-${index}@example.com`;
          return {
            provider: "microsoft_graph" as const,
            email: address,
            normalizedEmail: address,
            status: "available" as const,
            syncCursor: `cursor-${index}`,
            lastSyncedAt: new Date("2026-08-14T10:00:00.000Z"),
          };
        }),
      )
      .returning({ id: schema.mailboxConnections.id });
    try {
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
      });

      const outcome = (await services["reconcile-inbound-mailboxes"]({
        observedAt: "2026-08-14T10:42:00.000Z",
        limit: 7,
      })) as { results: Array<{ mailboxId: string }> };
      expect(outcome).toMatchObject({ results: expect.any(Array) });
      expect(reconciled).toHaveLength(7);
      expect(new Set(reconciled)).toEqual(
        new Set(
          created
            .map((row) => row.id)
            .sort()
            .slice(0, 7),
        ),
      );
      expect(outcome.results.map((result) => result.mailboxId)).toEqual(
        created
          .map((row) => row.id)
          .sort()
          .slice(0, 7),
      );
    } finally {
      registerInboundProvider("microsoft_graph", originalGraph);
      await db.delete(schema.mailboxConnections).where(
        inArray(
          schema.mailboxConnections.id,
          created.map((row) => row.id),
        ),
      );
    }
  });

  it("heartbeats an owned cycle and fences a stale owner's late success", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let firstClockMs = Date.parse("2026-08-14T10:00:00.000Z");
    const firstStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return { processed: 0 };
      }),
    });
    const first = runMaintenanceCycle(
      db,
      firstStages,
      { observedAt: "2026-08-14T10:00:00.000Z" },
      {
        clock: () => new Date((firstClockMs += 1_000)),
        createOwnerToken: () => "stale-owner",
        heartbeatMs: 10,
        leaseStaleMs: 120_000,
      },
    );
    await firstStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heartbeating = await projection();
    expect(heartbeating.ownerToken).toBe("stale-owner");
    expect(heartbeating.heartbeatAt!.getTime()).toBeGreaterThan(
      heartbeating.cycleStartedAt!.getTime(),
    );

    const takeoverStages = stages();
    const takeover = await runMaintenanceCycle(
      db,
      takeoverStages,
      { observedAt: "2026-08-14T10:03:00.000Z" },
      {
        clock: () => new Date("2026-08-14T10:03:00.000Z"),
        createOwnerToken: () => "new-owner",
        heartbeatMs: 60_000,
        leaseStaleMs: 120_000,
      },
    );
    expect(takeover).toMatchObject({ status: "succeeded" });

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ status: "busy" });
    const afterLateSuccess = await projection();
    expect(afterLateSuccess).toMatchObject({
      ownerToken: null,
      lastFailedAt: null,
      lastError: null,
    });
    expect(afterLateSuccess.lastSucceededAt?.toISOString()).toBe(
      "2026-08-14T10:03:00.000Z",
    );
    expect(firstStages["reconcile-due-follow-ups"]).not.toHaveBeenCalled();
  });

  it("treats a late stale-owner failure as neutral busy without a retryable audit failure", async () => {
    const firstStarted = deferred();
    const failFirst = deferred();
    const firstStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        firstStarted.resolve();
        await failFirst.promise;
        return { processed: 0 };
      }),
    });
    const firstRuntime = new WorkflowRuntime(db, workflowServices(firstStages));
    const firstDispatcher = new LocalWorkflowDispatcher(
      db,
      (input) =>
        firstRuntime.execute(input.task, input.payload, {
          runId: input.runId,
          attempt: input.attempt,
        }),
      { createRunId: () => "late-owner-run" },
    );
    const first = firstDispatcher.dispatch({
      task: "maintenance-cycle",
      payload: { observedAt: "2026-08-14T10:00:00.000Z" },
      idempotencyKey: "maintenance:cycle:2026-08-14T10:00",
    });
    await firstStarted.promise;
    await runMaintenanceCycle(
      db,
      stages(),
      { observedAt: "2026-08-14T10:03:00.000Z" },
      {
        clock: () => new Date("2026-08-14T10:03:00.000Z"),
        createOwnerToken: () => "replacement-owner",
        heartbeatMs: 60_000,
        leaseStaleMs: 120_000,
      },
    );

    failFirst.reject(new Error("token=old-owner-secret"));
    await expect(first).resolves.toEqual({
      runId: "late-owner-run",
      duplicate: false,
    });
    const row = await projection();
    expect(row.lastSucceededAt?.toISOString()).toBe("2026-08-14T10:03:00.000Z");
    expect(row.lastFailedAt).toBeNull();
    expect(row.lastError).toBeNull();
    const lateOwnerEvents = await db
      .select({ status: schema.workflowEvents.status })
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, "late-owner-run"));
    expect(lateOwnerEvents).not.toContainEqual({ status: "failed" });
  });

  it("serializes heartbeat renewals and drains the launched renewal before settling", async () => {
    const releaseHeartbeat = deferred();
    const controlled = controlledHeartbeatDatabase(releaseHeartbeat.promise);
    const permitFailure = deferred();
    const failingStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        await permitFailure.promise;
        throw new Error("inbound failed");
      }),
    });
    let settled = false;
    const cycle = runMaintenanceCycle(
      controlled.db,
      failingStages,
      { observedAt: "2026-08-14T10:00:00.000Z" },
      {
        clock: () => new Date("2026-08-14T10:00:00.000Z"),
        createOwnerToken: () => "heartbeat-owner",
        heartbeatMs: 5,
        leaseStaleMs: 120_000,
      },
    );
    void cycle.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await controlled.heartbeatStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    permitFailure.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controlled.concurrency().maximum).toBe(1);
    expect(settled).toBe(false);
    releaseHeartbeat.resolve();
    await expect(cycle).rejects.toThrow("Maintenance cycle failed");
    expect(controlled.concurrency()).toEqual({ active: 0, maximum: 1 });
  });

  it("executes inbound, due follow-ups, then stale recovery in exact order", async () => {
    const order: string[] = [];
    const orderedStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        order.push("inbound");
        return { processed: 1 };
      }),
      "reconcile-due-follow-ups": vi.fn(async () => {
        order.push("followups");
        return [{ sent: 1 }];
      }),
      "recover-stale-work": vi.fn(async () => {
        order.push("recovery");
        return { recovered: 1 };
      }),
    });

    await expect(
      runMaintenanceCycle(
        db,
        orderedStages,
        { observedAt: "2026-08-14T10:42:00.000Z" },
        {
          clock: () => new Date("2026-08-14T10:42:00.000Z"),
          createOwnerToken: () => "ordered-owner",
          heartbeatMs: 60_000,
          leaseStaleMs: 120_000,
        },
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(order).toEqual(["inbound", "followups", "recovery"]);
  });

  it("aborts after inbound failure, persists a sanitized failure, and releases ownership", async () => {
    const failedStages = stages({
      "reconcile-inbound-mailboxes": vi.fn(async () => {
        throw new Error("token=super-secret-provider-value\nIMAP failed");
      }),
    });

    await expect(
      runMaintenanceCycle(
        db,
        failedStages,
        { observedAt: "2026-08-14T10:42:00.000Z" },
        {
          clock: () => new Date("2026-08-14T10:42:00.000Z"),
          createOwnerToken: () => "failing-owner",
          heartbeatMs: 60_000,
          leaseStaleMs: 120_000,
        },
      ),
    ).rejects.toThrow("Maintenance cycle failed");

    expect(failedStages["reconcile-due-follow-ups"]).not.toHaveBeenCalled();
    expect(failedStages["recover-stale-work"]).not.toHaveBeenCalled();
    const row = await projection();
    expect(row.ownerToken).toBeNull();
    expect(row.lastFailedAt?.toISOString()).toBe("2026-08-14T10:42:00.000Z");
    expect(row.lastError).toBe("Maintenance inbound stage failed");
    expect(row.lastError).not.toContain("super-secret-provider-value");
  });

  it.each([
    [
      "inbound",
      "reconcile-inbound-mailboxes",
      "Maintenance inbound stage failed",
    ],
    [
      "followup",
      "reconcile-due-follow-ups",
      "Maintenance follow-up stage failed",
    ],
    ["recovery", "recover-stale-work", "Maintenance recovery stage failed"],
  ] as const)(
    "persists only the allowlisted %s failure category in projection and audit",
    async (stageName, task, allowedFailure) => {
      const secrets = [
        "hunter2",
        "json-api-secret",
        "bearer-secret",
        "equals-secret",
        "dsn-secret",
      ];
      const providerError = [
        "password: hunter2",
        '{"api_key":"json-api-secret"}',
        "Authorization: Bearer bearer-secret",
        "token=equals-secret",
        "postgresql://user:dsn-secret@database.example/app",
      ].join(" ");
      const failingStages = stages({
        [task]: vi.fn(async () => {
          throw new Error(providerError);
        }),
      });
      const runtime = new WorkflowRuntime(db, workflowServices(failingStages));
      const dispatcher = new LocalWorkflowDispatcher(
        db,
        (input) =>
          runtime.execute(input.task, input.payload, {
            runId: input.runId,
            attempt: input.attempt,
          }),
        { createRunId: () => `allowlist-${stageName}-run` },
      );

      await expect(
        dispatcher.dispatch({
          task: "maintenance-cycle",
          payload: { observedAt: "2026-08-14T10:42:00.000Z" },
          idempotencyKey: `maintenance:allowlist:${stageName}`,
        }),
      ).rejects.toThrow("Workflow task failed");

      const row = await projection();
      expect(row.lastError).toBe(allowedFailure);
      const audits = await db
        .select({
          event: schema.workflowEvents.event,
          error: schema.workflowEvents.error,
          payload: schema.workflowEvents.payload,
        })
        .from(schema.workflowEvents)
        .where(eq(schema.workflowEvents.runId, `allowlist-${stageName}-run`));
      const attempt = audits.find(
        (audit) => audit.event === "maintenance-cycle.attempt",
      );
      expect(attempt?.error).toBe(allowedFailure);
      const persisted = JSON.stringify({ row, audits });
      for (const secret of secrets) expect(persisted).not.toContain(secret);
    },
  );

  it("retains a historical sanitized failure after a later successful cycle", async () => {
    await expect(
      runMaintenanceCycle(
        db,
        stages({
          "reconcile-inbound-mailboxes": vi.fn(async () => {
            throw new Error("token=historical-secret IMAP failed");
          }),
        }),
        { observedAt: "2026-08-14T10:42:00.000Z" },
        {
          clock: () => new Date("2026-08-14T10:42:00.000Z"),
          createOwnerToken: () => "failing-owner",
          heartbeatMs: 60_000,
          leaseStaleMs: 120_000,
        },
      ),
    ).rejects.toThrow("Maintenance cycle failed");

    await expect(
      runMaintenanceCycle(
        db,
        stages(),
        { observedAt: "2026-08-14T10:43:00.000Z" },
        {
          clock: () => new Date("2026-08-14T10:43:00.000Z"),
          createOwnerToken: () => "successful-owner",
          heartbeatMs: 60_000,
          leaseStaleMs: 120_000,
        },
      ),
    ).resolves.toMatchObject({ status: "succeeded" });

    const row = await projection();
    expect(row.lastSucceededAt?.toISOString()).toBe("2026-08-14T10:43:00.000Z");
    expect(row.lastFailedAt?.toISOString()).toBe("2026-08-14T10:42:00.000Z");
    expect(row.lastError).toBe("Maintenance inbound stage failed");
    expect(row.lastError).not.toContain("historical-secret");
    expect(
      resolveMaintenanceStatus(row, {
        now: new Date("2026-08-14T10:44:00.000Z"),
        intervalMs: 60_000,
        codeTimeoutMs: 240_000,
        staleLeaseMs: 120_000,
      }).state,
    ).toBe("healthy");
  });

  it("deduplicates the same minute across dispatcher restart and audits one aggregate attempt", async () => {
    const cycleStages = stages();
    const runtime = new WorkflowRuntime(db, workflowServices(cycleStages));
    const request = {
      task: "maintenance-cycle" as const,
      payload: { observedAt: "2026-08-14T10:42:00.000Z" },
      idempotencyKey: "maintenance:cycle:2026-08-14T10:42",
    };
    const first = new LocalWorkflowDispatcher(
      db,
      (input) =>
        runtime.execute(input.task, input.payload, {
          runId: input.runId,
          attempt: input.attempt,
        }),
      { createRunId: () => "first-process-run" },
    );
    const restarted = new LocalWorkflowDispatcher(
      db,
      (input) =>
        runtime.execute(input.task, input.payload, {
          runId: input.runId,
          attempt: input.attempt,
        }),
      { createRunId: () => "restarted-process-run" },
    );

    await expect(first.dispatch(request)).resolves.toEqual({
      runId: "first-process-run",
      duplicate: false,
    });
    await expect(restarted.dispatch(request)).resolves.toEqual({
      runId: "first-process-run",
      duplicate: true,
    });
    expect(cycleStages["reconcile-inbound-mailboxes"]).toHaveBeenCalledOnce();
    expect(cycleStages["reconcile-due-follow-ups"]).toHaveBeenCalledOnce();
    expect(cycleStages["recover-stale-work"]).toHaveBeenCalledOnce();

    const aggregateAttempts = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.event, "maintenance-cycle.attempt"));
    expect(aggregateAttempts).toHaveLength(1);
    expect(aggregateAttempts[0]).toMatchObject({
      workflowName: "maintenance-cycle",
      status: "succeeded",
    });
  });
});
