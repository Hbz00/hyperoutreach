import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import {
  enqueueOperatorCommand,
  requeueOperatorCommand,
} from "@/modules/workflows/operator-command-queue";
import {
  readDueFollowUps,
  readQueuedWork,
  readRecentSends,
  readSendBudgets,
} from "@/modules/workflows/outbound-today";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

let fixtureNumber = 0;

async function campaignFixture(
  options: { personalized?: boolean; nullDeclaration?: boolean } = {},
) {
  fixtureNumber += 1;
  const suffix = `${fixtureNumber}-${crypto.randomUUID().slice(0, 8)}`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "mock",
      email: `box-${suffix}@example.com`,
      normalizedEmail: `box-${suffix}@example.com`,
      status: "available",
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `Acme ${suffix}`, normalizedName: `acme-${suffix}` })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      normalizedFullName: `ada-${suffix}`,
      jobTitle: "CTO",
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Outbound ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Show what is about to go out",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
    .returning();
  await db.insert(schema.sequenceSteps).values([
    {
      campaignVersionId: version!.id,
      stepIndex: 0,
      delayMinutes: 0,
      subjectTemplate: "Hello {{first_name}}",
      bodyTemplate: "A note for {{company}}",
    },
    {
      campaignVersionId: version!.id,
      stepIndex: 1,
      delayMinutes: 4_320,
      subjectTemplate: "Following up, {{first_name}}",
      bodyTemplate: "Still about {{company}}, {{job_title}}",
      ...(options.personalized
        ? {
            personalizationSchema: {
              fields: ["personalized_opening"],
              minConfidence: 0.5,
            },
          }
        : {}),
    },
  ]);
  // Before the enrollment exists, because the database makes a used version's
  // steps immutable — which is also why this state can only ever arrive at
  // insert time, from outside the application.
  if (options.nullDeclaration) {
    await db.execute(
      sql`update sequence_steps set personalization_schema = 'null'::jsonb
          where campaign_version_id = ${version!.id}`,
    );
  }
  await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id));
  const [enrollment] = await db
    .insert(schema.enrollments)
    .values({
      campaignId: campaign!.id,
      campaignVersionId: version!.id,
      contactId: contact!.id,
      mailboxId: mailbox!.id,
      state: "waiting",
      currentStep: 1,
      nextActionAt: new Date(NOW.getTime() + 3_600_000),
      nextActionToken: crypto.randomUUID(),
    })
    .returning();
  return {
    mailbox: mailbox!,
    account: account!,
    campaign: campaign!,
    version: version!,
    enrollment: enrollment!,
  };
}

describe("what goes out today", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const result = await updateOperatorSendingSettings(db, {
      emergencyPause: false,
      timezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 1_440,
      mailboxDailyCap: 25,
      campaignDailyCap: 100,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 0,
      crossCampaignCooldownDays: 0,
      actor: "operator",
    });
    if (!result.ok) throw new Error(result.code);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await db.delete(schema.operatorCommands);
  });

  it("shows the text a due follow-up would carry, and says what it depends on", async () => {
    const fixture = await campaignFixture();

    const due = await readDueFollowUps(db, { now: NOW });

    const row = due.find((item) => item.enrollmentId === fixture.enrollment.id);
    expect(row).toMatchObject({
      step: 2,
      subject: "Following up, Ada",
      body: `Still about ${fixture.account.name}, CTO`,
    });
    expect(row!.note).toContain("Projected");
  });

  // A step that asks the AI for a sentence has no text to preview: the
  // sentence is written when the message is generated, not before. Any step
  // may declare one — the follow-up path hands such a step to the command
  // queue rather than generating it inline — so this is a state a published
  // campaign reaches normally.
  it("does not invent a preview for a step that will be personalized", async () => {
    const fixture = await campaignFixture({ personalized: true });

    const due = await readDueFollowUps(db, { now: NOW });

    const row = due.find((item) => item.enrollmentId === fixture.enrollment.id);
    expect(row).toMatchObject({ subject: null, body: null });
    expect(row!.note).toContain("Personalized at generation");
  });

  // `personalization_schema` is `jsonb not null`, which does not exclude the
  // JSON value `null` — a hand-written UPDATE or a restored dump can put one
  // there. The projection reads every due row in one `map`, so a single such
  // row used to throw and take the whole page with it, hiding every follow-up
  // rather than one. `stepDeclaresPersonalization` is the tree's one answer to
  // "does this step need an agent", and it already treats malformed as
  // "declares nothing".
  it("survives a step whose declaration is stored as JSON null", async () => {
    const fixture = await campaignFixture({ nullDeclaration: true });

    const due = await readDueFollowUps(db, { now: NOW });

    const row = due.find((item) => item.enrollmentId === fixture.enrollment.id);
    expect(row).toBeDefined();
    expect(row!.note).toContain("Projected");
  });

  // The counter has to agree with the policy or it promises capacity that is
  // already spent: the policy charges an attempt, not only a delivery.
  it("counts a refused attempt against the budget, exactly as the policy does", async () => {
    const fixture = await campaignFixture();
    const [message] = await db
      .insert(schema.messages)
      .values({
        enrollmentId: fixture.enrollment.id,
        mailboxId: fixture.mailbox.id,
        stepIndex: 5,
        direction: "outbound",
        outreachId: `out_${crypto.randomUUID()}`,
        subject: "Attempted",
        body: "Attempted",
        recipient: `attempt-${crypto.randomUUID()}@example.com`,
        contactAccountId: fixture.account.id,
        employmentVersion: 1,
        status: "failed",
        // Attempted, never delivered. The policy still counts it.
        sendAttemptedAt: new Date(NOW.getTime() - 60_000),
        attemptCount: 1,
      })
      .returning();
    expect(message).toBeTruthy();

    const budgets = await readSendBudgets(db, NOW);

    expect(
      budgets.find(
        (budget) =>
          budget.scope === "mailbox" && budget.name === fixture.mailbox.email,
      ),
    ).toMatchObject({ used: 1, cap: 25 });
    expect(
      budgets.find(
        (budget) =>
          budget.scope === "campaign" && budget.name === fixture.campaign.name,
      ),
    ).toMatchObject({ used: 1, cap: 100 });
  });

  // Publishing a version is routine — turning on personalization does it — and
  // the policy charges the cap per campaign across all of them. Splitting the
  // count by version would show two half-spent budgets and promise capacity
  // that is already gone.
  it("counts one campaign once, however many versions it has", async () => {
    const fixture = await campaignFixture();
    const [secondVersion] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: fixture.campaign.id, version: 2, publishedAt: NOW })
      .returning();
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        accountId: fixture.account.id,
        firstName: "Alan",
        lastName: "Turing",
        fullName: "Alan Turing",
        normalizedFullName: `alan-${crypto.randomUUID()}`,
      })
      .returning();
    const [otherEnrollment] = await db
      .insert(schema.enrollments)
      .values({
        campaignId: fixture.campaign.id,
        campaignVersionId: secondVersion!.id,
        contactId: contact!.id,
        mailboxId: fixture.mailbox.id,
        state: "active",
      })
      .returning();
    for (const enrollmentId of [fixture.enrollment.id, otherEnrollment!.id]) {
      await db.insert(schema.messages).values({
        enrollmentId,
        mailboxId: fixture.mailbox.id,
        stepIndex: 9,
        direction: "outbound",
        outreachId: `out_${crypto.randomUUID()}`,
        subject: "Spent",
        body: "Spent",
        recipient: `spent-${crypto.randomUUID()}@example.com`,
        contactAccountId: fixture.account.id,
        employmentVersion: 1,
        status: "sent",
        sentAt: new Date(NOW.getTime() - 60_000),
      });
    }

    const budgets = await readSendBudgets(db, NOW);

    const forCampaign = budgets.filter(
      (budget) =>
        budget.scope === "campaign" && budget.name === fixture.campaign.name,
    );
    expect(forCampaign).toHaveLength(1);
    expect(forCampaign[0]).toMatchObject({ used: 2 });
  });

  // The count is per campaign, but the cap the policy reads is per version.
  // Two live versions can carry different overrides, so there is no single
  // true number — the honest one is the newest published version's, which is
  // what every send from here on is measured against. Taking the largest
  // announced capacity the policy had already refused to grant.
  // The count is per campaign, but the cap the policy reads is per version.
  // Versions are immutable, so tightening a cap means publishing a new one and
  // leaving the old one live — and the two then disagree. There is no single
  // true number; the honest one is the newest published version's, which every
  // send from here on is measured against. Taking the largest announced
  // capacity the policy had already stopped granting.
  it("shows the newest published version's cap, not the most generous one", async () => {
    const fixture = await campaignFixture();
    const enrolOn = async (version: number, campaignDailyCap: number) => {
      const [published] = await db
        .insert(schema.campaignVersions)
        .values({
          campaignId: fixture.campaign.id,
          version,
          publishedAt: NOW,
          configuration: { campaignDailyCap },
        })
        .returning();
      const [contact] = await db
        .insert(schema.contacts)
        .values({
          accountId: fixture.account.id,
          firstName: "Katherine",
          lastName: "Johnson",
          fullName: "Katherine Johnson",
          normalizedFullName: `katherine-${crypto.randomUUID()}`,
        })
        .returning();
      // A version nobody is enrolled on cannot spend anything, so it is rightly
      // invisible here. The cap becomes the operator's reality with the first
      // prospect on it.
      await db.insert(schema.enrollments).values({
        campaignId: fixture.campaign.id,
        campaignVersionId: published!.id,
        contactId: contact!.id,
        mailboxId: fixture.mailbox.id,
        state: "active",
      });
    };
    await enrolOn(2, 200);
    await enrolOn(3, 20);

    const budgets = await readSendBudgets(db, NOW);

    expect(
      budgets.find(
        (budget) =>
          budget.scope === "campaign" && budget.name === fixture.campaign.name,
      ),
    ).toMatchObject({ cap: 20 });
  });

  it("lists work the cycle has not finished with, and what stopped it", async () => {
    const queued = await enqueueOperatorCommand(db, {
      command: "research-account",
      payload: { accountId: crypto.randomUUID() },
      requestedBy: "operator@example.com",
    });

    const work = await readQueuedWork(db);

    expect(work).toEqual([
      expect.objectContaining({
        id: queued.id,
        command: "research-account",
        status: "queued",
        retryable: false,
      }),
    ]);
  });

  // "LOW_CONFIDENCE" tells the operator that something stopped. The sentence
  // the service wrote tells them what to do about it.
  it("shows why a command stopped in words, not in codes", async () => {
    const queued = await enqueueOperatorCommand(db, {
      command: "generate-message",
      payload: { enrollmentId: crypto.randomUUID(), stepIndex: 0 },
      requestedBy: "operator@example.com",
    });
    await db
      .update(schema.operatorCommands)
      .set({
        status: "abandoned",
        attempt: 1,
        error: "LOW_CONFIDENCE",
        result: {
          ok: false,
          code: "LOW_CONFIDENCE",
          message:
            "The agent was 0.20 confident, below the 0.50 this step requires",
        },
      })
      .where(eq(schema.operatorCommands.id, queued.id));

    const work = (await readQueuedWork(db)).find((row) => row.id === queued.id);

    expect(work!.detail).toContain("0.20");
    expect(work!.detail).toContain("0.50");
  });

  it("says what a parked command is waiting for, in words", async () => {
    const queued = await enqueueOperatorCommand(db, {
      command: "generate-message",
      payload: { enrollmentId: crypto.randomUUID(), stepIndex: 0 },
      requestedBy: "operator@example.com",
    });
    await db
      .update(schema.operatorCommands)
      .set({ status: "waiting", waitingReason: "awaiting_account_research" })
      .where(eq(schema.operatorCommands.id, queued.id));

    const work = (await readQueuedWork(db)).find((row) => row.id === queued.id);

    expect(work!.detail).toBe("Waiting for this company to be researched");
  });

  it("offers a retry that actually re-arms abandoned work", async () => {
    const queued = await enqueueOperatorCommand(db, {
      command: "research-account",
      payload: { accountId: crypto.randomUUID() },
      requestedBy: "operator@example.com",
    });
    await db
      .update(schema.operatorCommands)
      .set({ status: "abandoned", attempt: 3, error: "AGENT_ERROR" })
      .where(eq(schema.operatorCommands.id, queued.id));

    expect(
      (await readQueuedWork(db)).find((row) => row.id === queued.id),
    ).toMatchObject({ status: "abandoned", retryable: true });
    expect(await requeueOperatorCommand(db, { id: queued.id })).toBe(true);

    expect(
      (await readQueuedWork(db)).find((row) => row.id === queued.id),
    ).toMatchObject({ status: "queued", attempt: 0 });
  });

  it("refuses to re-arm work that is already running", async () => {
    const queued = await enqueueOperatorCommand(db, {
      command: "research-account",
      payload: { accountId: crypto.randomUUID() },
      requestedBy: "operator@example.com",
    });
    await db
      .update(schema.operatorCommands)
      .set({ status: "running", claimId: "live", claimedAt: NOW })
      .where(eq(schema.operatorCommands.id, queued.id));

    expect(await requeueOperatorCommand(db, { id: queued.id })).toBe(false);
  });

  it("shows what has just gone out", async () => {
    const fixture = await campaignFixture();
    // The send policy only lets an active sequence through, and the fixture
    // parks its enrollment mid-wait for the due-follow-up tests above.
    await db
      .update(schema.enrollments)
      .set({ state: "active" })
      .where(eq(schema.enrollments.id, fixture.enrollment.id));
    const [message] = await db
      .insert(schema.messages)
      .values({
        enrollmentId: fixture.enrollment.id,
        mailboxId: fixture.mailbox.id,
        // The policy refuses a message whose step is not the sequence's
        // current one, so this has to be the step the enrollment is on.
        stepIndex: fixture.enrollment.currentStep,
        direction: "outbound",
        outreachId: `out_${crypto.randomUUID()}`,
        subject: "Just sent",
        body: "Just sent",
        recipient: `sent-${crypto.randomUUID()}@example.com`,
        contactAccountId: fixture.account.id,
        employmentVersion: 1,
        status: "approved",
      })
      .returning();
    expect(
      await sendApprovedMessage(
        db,
        new DatabaseMockMailProvider(db),
        { messageId: message!.id },
        { clock: () => NOW },
      ),
    ).toMatchObject({ ok: true, disposition: "sent" });

    const recent = await readRecentSends(db, { now: NOW });

    expect(recent.find((row) => row.messageId === message!.id)).toMatchObject({
      status: "sent",
      subject: "Just sent",
    });
  });
});
