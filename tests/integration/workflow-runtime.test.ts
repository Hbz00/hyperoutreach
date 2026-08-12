import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { executeAuditedWorkflow } from "@/modules/workflows/execution-audit";
import { LocalWorkflowDispatcher } from "@/modules/workflows/dispatcher";
import { dispatchDueFollowUps } from "@/modules/workflows/recovery-service";
import { findStaleRecoveryCandidates } from "@/modules/workflows/recovery-service";
import { WorkflowRuntime } from "@/modules/workflows/runtime";
import type { WorkflowTaskServices } from "@/modules/workflows/runtime";
import { WORKFLOW_TASKS } from "@/modules/workflows/task-contracts";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

function successfulWorkflowServices(): WorkflowTaskServices {
  return Object.fromEntries(
    Object.keys(WORKFLOW_TASKS).map((task) => [
      task,
      async () => ({ ok: true, task }),
    ]),
  ) as unknown as WorkflowTaskServices;
}

describe("durable workflow execution audit", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("persists every executor attempt and sanitized completion state", async () => {
    const entityId = crypto.randomUUID();
    const operation = vi.fn(async () => ({ disposition: "reused" }));

    await expect(
      executeAuditedWorkflow(
        db,
        {
          task: "account-research",
          runId: "run_abc",
          attempt: 2,
          entityType: "account",
          entityId,
          logicalKey: `research:${entityId}:v1`,
          payload: { accountId: entityId },
        },
        operation,
      ),
    ).resolves.toEqual({ disposition: "reused" });

    const [event] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, "run_abc"));
    expect(event).toMatchObject({
      entityType: "account",
      entityId,
      workflowName: "account-research",
      runId: "run_abc",
      attempt: 2,
      status: "succeeded",
      error: null,
    });
    expect(event?.payload).toMatchObject({
      logicalKey: `research:${entityId}:v1`,
      input: { accountId: entityId },
      output: { disposition: "reused" },
    });
  });

  it("records a retryable failure without exposing its secret-bearing message", async () => {
    const entityId = crypto.randomUUID();
    await expect(
      executeAuditedWorkflow(
        db,
        {
          task: "send-approved-message",
          runId: "run_failed",
          attempt: 1,
          entityType: "message",
          entityId,
          logicalKey: `send:${entityId}`,
          payload: { messageId: entityId },
        },
        async () => {
          throw new Error("refresh_token=super-secret-provider-value");
        },
      ),
    ).rejects.toThrow("Workflow task failed");

    const [event] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, "run_failed"));
    expect(event).toMatchObject({
      status: "failed",
      error: "Workflow task failed",
    });
    expect(JSON.stringify(event)).not.toContain("super-secret-provider-value");
  });

  it("recovers due database schedules and globally deduplicates repeat scans", async () => {
    const [account] = await db
      .insert(schema.accounts)
      .values({
        name: "Recovery",
        normalizedName: `recovery-${crypto.randomUUID()}`,
      })
      .returning();
    if (!account) throw new Error("account fixture missing");
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        accountId: account.id,
        firstName: "Due",
        lastName: "Contact",
        fullName: "Due Contact",
        normalizedFullName: `due-contact-${crypto.randomUUID()}`,
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        name: "Recovery campaign",
        type: "customer_discovery",
        status: "active",
        targetDescription: "Recover durable work after executor downtime",
      })
      .returning();
    if (!contact || !campaign) throw new Error("campaign fixture missing");
    const [version] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: campaign.id, version: 1, publishedAt: new Date() })
      .returning();
    if (!version) throw new Error("version fixture missing");
    const dueAt = new Date("2026-08-12T10:00:00.000Z");
    const [enrollment] = await db
      .insert(schema.enrollments)
      .values({
        campaignId: campaign.id,
        campaignVersionId: version.id,
        contactId: contact.id,
        state: "waiting",
        currentStep: 1,
        nextActionAt: dueAt,
        nextActionToken: "due-token",
      })
      .returning();
    if (!enrollment) throw new Error("enrollment fixture missing");

    const execute = vi.fn(async () => ({ ok: true }));
    const dispatcher = new LocalWorkflowDispatcher(
      db,
      execute,
      () => "local-due-run",
    );
    const first = await dispatchDueFollowUps(db, dispatcher, {
      now: new Date("2026-08-12T10:01:00.000Z"),
    });
    const repeat = await dispatchDueFollowUps(db, dispatcher, {
      now: new Date("2026-08-12T10:02:00.000Z"),
    });

    expect(first).toEqual([{ runId: "local-due-run", duplicate: false }]);
    expect(repeat).toEqual([{ runId: "local-due-run", duplicate: true }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      task: "advance-sequence",
      runId: "local-due-run",
      attempt: 1,
      payload: {
        enrollmentId: enrollment.id,
        expectedStep: 1,
        expectedVersionId: version.id,
        expectedDueAt: dueAt.toISOString(),
        expectedToken: "due-token",
      },
    });
  });

  it("finds uncertain sends and expired provider claims after executor downtime", async () => {
    const staleAt = new Date("2026-08-12T09:00:00.000Z");
    const now = new Date("2026-08-12T10:00:00.000Z");
    const [account] = await db
      .insert(schema.accounts)
      .values({
        name: "Stale recovery",
        normalizedName: `stale-recovery-${crypto.randomUUID()}`,
        researchStatus: "in_progress",
        researchClaimId: crypto.randomUUID(),
        researchClaimedAt: staleAt,
      })
      .returning();
    if (!account) throw new Error("stale account missing");
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        accountId: account.id,
        firstName: "Stale",
        lastName: "Contact",
        fullName: "Stale Contact",
        normalizedFullName: `stale-contact-${crypto.randomUUID()}`,
        emailResolutionClaimId: crypto.randomUUID(),
        emailResolutionClaimedAt: staleAt,
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        name: "Stale recovery campaign",
        type: "commercial_outreach",
        status: "active",
        targetDescription: "Recover an uncertain provider outcome",
      })
      .returning();
    if (!contact || !campaign) throw new Error("stale fixture missing");
    const [version] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: campaign.id, version: 1, publishedAt: now })
      .returning();
    if (!version) throw new Error("stale version missing");
    const [enrollment] = await db
      .insert(schema.enrollments)
      .values({
        campaignId: campaign.id,
        campaignVersionId: version.id,
        contactId: contact.id,
        state: "approved",
      })
      .returning();
    if (!enrollment) throw new Error("stale enrollment missing");
    const [message] = await db
      .insert(schema.messages)
      .values({
        enrollmentId: enrollment.id,
        stepIndex: 0,
        direction: "outbound",
        outreachId: `out_${crypto.randomUUID()}`,
        subject: "Stale",
        body: "Stale",
        recipient: "stale@example.com",
        contactAccountId: account.id,
        employmentVersion: contact.employmentVersion,
        status: "delivery_uncertain",
        sendAttemptToken: crypto.randomUUID(),
        sendClaimedAt: staleAt,
        attemptCount: 1,
      })
      .returning();
    if (!message) throw new Error("stale message missing");

    await expect(
      findStaleRecoveryCandidates(db, { now, claimLeaseMs: 60_000 }),
    ).resolves.toMatchObject({
      messageIds: expect.arrayContaining([message.id]),
      accountIds: expect.arrayContaining([account.id]),
      contactIds: expect.arrayContaining([contact.id]),
    });
  });

  it("keeps actionable messages moving when old uncertain rows poison recovery", async () => {
    const now = new Date("2026-08-12T10:00:00.000Z");
    const old = new Date("2025-08-12T08:00:00.000Z");
    const [account] = await db
      .insert(schema.accounts)
      .values({
        name: "Fair recovery",
        normalizedName: `fair-recovery-${crypto.randomUUID()}`,
      })
      .returning();
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        accountId: account!.id,
        firstName: "Fair",
        lastName: "Recovery",
        fullName: "Fair Recovery",
        normalizedFullName: `fair-recovery-${crypto.randomUUID()}`,
      })
      .returning();
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        name: "Fair recovery",
        type: "commercial_outreach",
        status: "active",
        targetDescription: "Fair recovery",
      })
      .returning();
    const [version] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: campaign!.id, version: 1, publishedAt: now })
      .returning();
    const [enrollment] = await db
      .insert(schema.enrollments)
      .values({
        campaignId: campaign!.id,
        campaignVersionId: version!.id,
        contactId: contact!.id,
        state: "approved",
      })
      .returning();
    const uncertainIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const [row] = await db
        .insert(schema.messages)
        .values({
          enrollmentId: enrollment!.id,
          stepIndex: 20 + index,
          direction: "outbound",
          outreachId: `poison-${crypto.randomUUID()}`,
          subject: "Poison",
          body: "Poison",
          recipient: `poison-${index}@example.com`,
          contactAccountId: account!.id,
          employmentVersion: 1,
          status: "delivery_uncertain",
          createdAt: old,
          updatedAt: old,
        })
        .returning({ id: schema.messages.id });
      uncertainIds.push(row!.id);
    }
    const [actionable] = await db
      .insert(schema.messages)
      .values({
        enrollmentId: enrollment!.id,
        stepIndex: 30,
        direction: "outbound",
        outreachId: `actionable-${crypto.randomUUID()}`,
        subject: "Actionable",
        body: "Actionable",
        recipient: "actionable@example.com",
        contactAccountId: account!.id,
        employmentVersion: 1,
        status: "approved",
      })
      .returning({ id: schema.messages.id });

    const candidates = await findStaleRecoveryCandidates(db, { now, limit: 2 });
    expect(candidates.messageIds).toContain(actionable!.id);
    expect(candidates.messageIds).toHaveLength(2);
    expect(
      candidates.messageIds.filter((id) => uncertainIds.includes(id)),
    ).toHaveLength(1);
    const firstUncertain = candidates.messageIds.find((id) =>
      uncertainIds.includes(id),
    );
    const nextTick = await findStaleRecoveryCandidates(db, {
      now: new Date(now.getTime() + 5 * 60_000),
      limit: 2,
    });
    expect(
      nextTick.messageIds.filter((id) => uncertainIds.includes(id)),
    ).toHaveLength(1);
    expect(nextTick.messageIds).not.toContain(firstUncertain);
  });

  it("retries a failed local dispatch without losing persistent idempotency", async () => {
    let attempts = 0;
    const dispatcher = new LocalWorkflowDispatcher(
      db,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient upstream failure");
        return { ok: true };
      },
      () => `local-retry-${attempts + 1}`,
    );
    const request = {
      task: "account-research" as const,
      payload: { accountId: crypto.randomUUID() },
      idempotencyKey: `retry-${crypto.randomUUID()}`,
    };
    await expect(dispatcher.dispatch(request)).rejects.toThrow(
      "Workflow task failed",
    );
    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({
      duplicate: false,
    });
    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({
      duplicate: true,
    });
    expect(attempts).toBe(2);
  });

  it("marks a resolved transient service outcome failed so the workflow executor retries", async () => {
    const accountId = crypto.randomUUID();
    let attempts = 0;
    const services = successfulWorkflowServices();
    services["account-research"] = async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, code: "AGENT_ERROR" }
        : { ok: true, disposition: "researched" };
    };
    const runtime = new WorkflowRuntime(db, services);

    await expect(
      runtime.execute(
        "account-research",
        { accountId },
        { runId: "trigger-transient", attempt: 1 },
      ),
    ).rejects.toThrow("Workflow task failed");
    await expect(
      runtime.execute(
        "account-research",
        { accountId },
        { runId: "trigger-transient", attempt: 2 },
      ),
    ).resolves.toMatchObject({ ok: true, disposition: "researched" });

    const events = await db
      .select({ status: schema.workflowEvents.status })
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, "trigger-transient"));
    expect(events.map((event) => event.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(attempts).toBe(2);
  });

  it("does not retry a terminal or uncertain service outcome", async () => {
    const messageId = crypto.randomUUID();
    const services = successfulWorkflowServices();
    services["send-approved-message"] = async () => ({
      ok: false,
      code: "DELIVERY_UNCERTAIN",
    });
    const runtime = new WorkflowRuntime(db, services);

    await expect(
      runtime.execute(
        "send-approved-message",
        { messageId },
        { runId: "trigger-uncertain", attempt: 1 },
      ),
    ).resolves.toEqual({ ok: false, code: "DELIVERY_UNCERTAIN" });
    const [event] = await db
      .select({ status: schema.workflowEvents.status })
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.runId, "trigger-uncertain"));
    expect(event?.status).toBe("succeeded");
  });

  it("reclaims an abandoned local dispatch lease after worker downtime", async () => {
    const accountId = crypto.randomUUID();
    const idempotencyKey = `abandoned-${crypto.randomUUID()}`;
    await db.insert(schema.workflowEvents).values({
      entityType: "system",
      entityId: "00000000-0000-0000-0000-000000000000",
      event: "account-research.dispatched",
      workflowName: "account-research",
      runId: "dead-worker-run",
      idempotencyKey: `dispatcher:account-research:${idempotencyKey}`,
      status: "started",
      startedAt: new Date("2026-08-12T09:00:00.000Z"),
    });
    const execute = vi.fn(async () => ({ ok: true }));
    const dispatcher = new LocalWorkflowDispatcher(db, execute, {
      createRunId: () => "recovered-worker-run",
      clock: () => new Date("2026-08-12T10:00:00.000Z"),
      leaseMs: 5 * 60_000,
    });

    await expect(
      dispatcher.dispatch({
        task: "account-research",
        payload: { accountId },
        idempotencyKey,
      }),
    ).resolves.toEqual({
      runId: "recovered-worker-run",
      duplicate: false,
    });
    expect(execute).toHaveBeenCalledWith({
      task: "account-research",
      payload: { accountId },
      runId: "recovered-worker-run",
      attempt: 2,
    });
  });
});
