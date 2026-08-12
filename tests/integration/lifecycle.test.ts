import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  OpenAIReplyClassifier,
  type StructuredAIProvider,
} from "@/modules/agents/openai-agents";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import {
  pauseCampaign,
  resumeCampaign,
  stopEnrollment,
} from "@/modules/campaigns/lifecycle-service";
import { createOrGetContact } from "@/modules/contacts/service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import {
  ingestInboundMessage,
  reconcilePendingInboundRecords,
} from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import type { ReplyClassifier } from "@/modules/replies/reply-classifier";
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from "@/modules/suppression/service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import {
  findDueEnrollments,
  processFollowUpInvocation,
  reconcileDueFollowUps,
} from "@/modules/workflows/follow-up-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 8 });
const db = drizzle(client, { schema });
const classifier = new DeterministicReplyClassifier();
let sequence = 0;

const sentAt = new Date("2026-08-11T10:00:00.000Z");

async function fixture(
  options: {
    automatic?: boolean;
    holdNonTerminal?: boolean;
    domain?: string;
    send?: boolean;
    relevant?: boolean;
    campaignDailyCap?: number;
    mailboxId?: string;
  } = {},
) {
  sequence += 1;
  const n = sequence;
  const domain = options.domain ?? `lifecycle-${n}.example`;
  const account = await createOrGetAccount(db, {
    name: `Lifecycle ${n}`,
    domain,
  });
  if (!account.ok) throw new Error(account.message);
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Ada",
    lastName: `Flow${n}`,
    jobTitle: "CTO",
    professionalRelevance: {
      relevant: options.relevant ?? true,
      reason: "Technology leader",
    },
  });
  if (!contact.ok) throw new Error(contact.message);
  const campaign = await createDraftCampaign(db, {
    name: `Lifecycle campaign ${n}`,
    type: "commercial_outreach",
    targetDescription: "Relevant technology leaders at B2B companies",
    configuration: {
      automaticFollowUps: options.automatic ?? false,
      holdNonTerminalReplies: options.holdNonTerminal ?? true,
      requireProfessionalRelevance: true,
      campaignDailyCap: options.campaignDailyCap ?? 100,
    },
    steps: [
      {
        delayMinutes: 0,
        subjectTemplate: "Hello {{first_name}}",
        bodyTemplate: "Initial for {{company}}",
      },
      {
        delayMinutes: 60,
        subjectTemplate: "Following up {{first_name}}",
        bodyTemplate: "Follow-up for {{company}}",
      },
    ],
  });
  if (!campaign.ok) throw new Error(campaign.message);
  const published = await publishCampaignVersion(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
  });
  if (!published.ok) throw new Error(published.message);
  const [mailbox] = options.mailboxId
    ? await db
        .select()
        .from(schema.mailboxConnections)
        .where(eq(schema.mailboxConnections.id, options.mailboxId))
        .limit(1)
    : await db
        .insert(schema.mailboxConnections)
        .values({
          provider: "mock",
          email: `operator-${n}@example.com`,
          normalizedEmail: `operator-${n}@example.com`,
          status: "available",
        })
        .returning();
  if (!mailbox) throw new Error("mailbox missing");
  const enrollment = await enrollContact(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
    contactId: contact.contact.id,
    mailboxId: mailbox.id,
  });
  if (!enrollment.ok) throw new Error(enrollment.message);
  const recipient = `ada-${n}@${domain}`;
  const proposal = await generateOutreachProposal(db, {
    enrollmentId: enrollment.enrollment.id,
    stepIndex: 0,
    recipient,
  });
  if (!proposal.ok) throw new Error(proposal.message);
  const review = await reviewMessage(db, {
    messageId: proposal.message.id,
    action: { kind: "approve" },
    actor: "operator",
  });
  if (!review.ok) throw new Error(review.message);
  const provider = new MockMailProvider();
  const sent =
    options.send === false
      ? null
      : await sendApprovedMessage(
          db,
          provider,
          { messageId: proposal.message.id },
          { clock: () => sentAt },
        );
  if (sent && !sent.ok) throw new Error(sent.code);
  const [storedEnrollment] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, enrollment.enrollment.id));
  if (!storedEnrollment) throw new Error("enrollment missing");
  return {
    account: account.account,
    campaign: campaign.campaign,
    contact: contact.contact,
    enrollment: storedEnrollment,
    mailbox,
    message: sent?.ok ? sent.message : review.message,
    provider,
    recipient,
    version: campaign.version,
  };
}

async function setPolicySettings(
  overrides: Partial<{
    emergencyPause: boolean;
    timezone: string;
    workingDays: number[];
    workingStartMinute: number;
    workingEndMinute: number;
    mailboxDailyCap: number;
    campaignDailyCap: number;
    mailboxMinimumDelaySeconds: number;
    contactMinimumDelayMinutes: number;
    crossCampaignCooldownDays: number;
  }> = {},
) {
  const result = await updateOperatorSendingSettings(db, {
    emergencyPause: false,
    timezone: "UTC",
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    workingStartMinute: 0,
    workingEndMinute: 1_440,
    mailboxDailyCap: 100,
    campaignDailyCap: 100,
    mailboxMinimumDelaySeconds: 0,
    contactMinimumDelayMinutes: 0,
    crossCampaignCooldownDays: 0,
    ...overrides,
    actor: "operator",
  });
  if (!result.ok) throw new Error(result.code);
}

async function waitForAdvisoryWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ count }] = await client<[{ count: number }]>`
      select count(*)::int as count
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Inbound ingestion never waited on the send action lock");
}

describe("durable lifecycle, inbound replies, and suppression", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => client.end());

  it("persists exactly one conservative operator settings row on a clean migration", async () => {
    const rows = await db.select().from(schema.operatorSendingSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      emergencyPause: false,
      mailboxDailyCap: 25,
      campaignDailyCap: 100,
    });
  });

  it("transactionally schedules the next immutable step after confirmed send", async () => {
    const f = await fixture();
    expect(f.enrollment).toMatchObject({
      state: "waiting",
      currentStep: 1,
      nextActionAt: new Date("2026-08-11T11:00:00.000Z"),
    });
    expect(f.enrollment.nextActionToken).toMatch(/^followup_/);
  });

  it("matches a normal in-reply-to message that starts before outbound provider identities persist", async () => {
    await setPolicySettings();
    const f = await fixture({ send: false });
    let releaseSend!: () => void;
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const sendDraftStarted = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    class HeldSendProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        sendStarted();
        await sendRelease;
        return super.sendDraft(input);
      }
    }
    const provider = new HeldSendProvider();
    const sending = sendApprovedMessage(db, provider, {
      messageId: f.message.id,
    });
    await sendDraftStarted;
    const replying = ingestInboundMessage(db, classifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `graph-race-reply-${sequence}`,
      inReplyTo: `<${f.message.outreachId}@mock.hyperoutreach>`,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, interested",
      receivedAt: new Date("2026-08-11T10:00:01.000Z"),
    });
    await waitForAdvisoryWaiter();
    releaseSend();
    expect(await sending).toMatchObject({ ok: true, disposition: "sent" });
    expect(await replying).toMatchObject({
      ok: true,
      disposition: "processed",
      reply: { enrollmentId: f.enrollment.id },
    });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored).toMatchObject({
      state: "replied",
      stopReason: "positive_reply",
      nextActionAt: null,
      nextActionToken: null,
    });
  });

  it("persists and holds a matched inbound before slow classification", async () => {
    await setPolicySettings();
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slowClassifier: ReplyClassifier = {
      name: "slow-test",
      async classify() {
        started();
        await held;
        return { category: "positive", confidence: 1, reason: "test" };
      },
    };
    const processing = ingestInboundMessage(db, slowClassifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `slow-classifier-${sequence}`,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    });
    await classificationStarted;
    const [inbound] = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        eq(
          schema.inboundRecords.providerMessageId,
          `slow-classifier-${sequence}`,
        ),
      );
    const [heldEnrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(inbound).toMatchObject({ status: "processing" });
    expect(heldEnrollment).toMatchObject({
      state: "manual_review",
      nextActionAt: null,
      nextActionToken: null,
    });
    release();
    expect(await processing).toMatchObject({
      ok: true,
      disposition: "processed",
    });
  });

  it("does not let reconciliation classify an inbound already owned by a webhook", async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let webhookCalls = 0;
    let reconciliationCalls = 0;
    const slowClassifier: ReplyClassifier = {
      name: "slow-webhook-owner",
      async classify() {
        webhookCalls += 1;
        await blocked;
        return { category: "positive", confidence: 0.9, reason: "interested" };
      },
    };
    const competingClassifier: ReplyClassifier = {
      name: "competing-reconciler",
      async classify() {
        reconciliationCalls += 1;
        return { category: "negative", confidence: 0.9, reason: "not now" };
      },
    };
    const providerMessageId = `owned-inbound-${sequence}`;
    const webhook = ingestInboundMessage(db, slowClassifier, {
      mailboxId: f.mailbox.id,
      providerMessageId,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, interested",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    });
    while (webhookCalls === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await reconcilePendingInboundRecords(db, competingClassifier, {
        limit: 10,
      }),
    ).toEqual([]);
    expect(reconciliationCalls).toBe(0);
    release();
    expect(await webhook).toMatchObject({ ok: true, disposition: "processed" });
    const [reply] = await db
      .select()
      .from(schema.replies)
      .innerJoin(
        schema.inboundRecords,
        eq(schema.inboundRecords.id, schema.replies.inboundRecordId),
      )
      .where(eq(schema.inboundRecords.providerMessageId, providerMessageId));
    expect(reply?.replies).toMatchObject({ classification: "positive" });
    const [enrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(enrollment).toMatchObject({
      state: "replied",
      inboundHoldCount: 0,
      nextActionAt: null,
    });
  });

  it("discards a classifier result after a stale owner loses its lease", async () => {
    const f = await fixture();
    const startedAt = new Date("2026-08-11T10:30:00.000Z");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerMessageId = `stale-owner-race-${sequence}`;
    const webhook = ingestInboundMessage(
      db,
      {
        name: "lost-positive-owner",
        async classify() {
          await blocked;
          return {
            category: "positive",
            confidence: 0.9,
            reason: "interested",
          };
        },
      },
      {
        mailboxId: f.mailbox.id,
        providerMessageId,
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Threaded response",
        body: "Ambiguous until classified",
        receivedAt: startedAt,
      },
      { now: startedAt, classificationClaimTtlMs: 1_000 },
    );
    while (true) {
      const [inbound] = await db
        .select()
        .from(schema.inboundRecords)
        .where(eq(schema.inboundRecords.providerMessageId, providerMessageId));
      if (inbound?.classificationClaimId) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      await reconcilePendingInboundRecords(
        db,
        {
          name: "takeover-negative-owner",
          async classify() {
            return {
              category: "negative",
              confidence: 0.95,
              reason: "declined",
            };
          },
        },
        {
          limit: 10,
          now: new Date(startedAt.getTime() + 2_000),
          classificationClaimTtlMs: 1_000,
        },
      ),
    ).toEqual([
      expect.objectContaining({ ok: true, disposition: "processed" }),
    ]);
    release();
    expect(await webhook).toEqual({ ok: false, code: "IN_PROGRESS" });
    const inboundRows = await db
      .select()
      .from(schema.inboundRecords)
      .where(eq(schema.inboundRecords.providerMessageId, providerMessageId));
    const replies = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.inboundRecordId, inboundRows[0]!.id));
    expect(replies).toEqual([
      expect.objectContaining({
        classification: "negative",
        classifier: "takeover-negative-owner",
      }),
    ]);
    const [enrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(enrollment).toMatchObject({
      state: "replied",
      inboundHoldCount: 0,
      lastReplyClassification: "negative",
    });
  });

  it("keeps failed classification visible and reconciles it later", async () => {
    const f = await fixture();
    const input = {
      mailboxId: f.mailbox.id,
      providerMessageId: `failed-classifier-${sequence}`,
      outreachId: f.message.outreachId!,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, interested",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    };
    const failing: ReplyClassifier = {
      name: "failing-test",
      async classify() {
        throw new Error("transient");
      },
    };
    expect(await ingestInboundMessage(db, failing, input)).toEqual({
      ok: false,
      code: "CLASSIFIER_ERROR",
    });
    const [failed] = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        eq(schema.inboundRecords.providerMessageId, input.providerMessageId),
      );
    expect(failed).toMatchObject({ status: "failed" });
    expect(await reconcilePendingInboundRecords(db, classifier)).toEqual([
      expect.objectContaining({ ok: true, disposition: "processed" }),
    ]);
  });

  it("audits the real observed classifier through inbound ingestion and links the reply", async () => {
    const f = await fixture();
    const aiClassifier = new OpenAIReplyClassifier(
      {
        run: async () => ({
          responseId: "resp_inbound_success",
          model: "gpt-5.6-luna",
          output: {
            category: "positive" as const,
            confidence: 0.96,
            reason: "The recipient requests a meeting.",
          },
          sources: [],
          usage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
          costUsd: 0.0042,
        }),
      } as unknown as StructuredAIProvider,
      "gpt-5.6-luna",
    );
    const inbound = await ingestInboundMessage(db, aiClassifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `ai-audit-${sequence}`,
      outreachId: f.message.outreachId!,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, let's arrange a meeting.",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    });
    expect(inbound).toMatchObject({ ok: true, disposition: "processed" });
    if (!inbound.ok) return;
    expect(inbound.reply.agentRunId).not.toBeNull();
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, inbound.reply.agentRunId!));
    expect(run).toMatchObject({
      agent: "reply_classifier",
      model: "gpt-5.6-luna",
      promptVersion: "reply-classifier-prompt-v1",
      schemaVersion: "reply-classifier-schema-v1",
      input: {
        sender: f.recipient,
        subject: "Interested",
        body: "Yes, let's arrange a meeting.",
      },
      output: {
        category: "positive",
        confidence: 0.96,
        reason: "The recipient requests a meeting.",
      },
      sources: [],
      tokenUsage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
      status: "succeeded",
      error: null,
    });
    expect(run?.costUsd).toBe("0.004200");
    expect(run?.completedAt).not.toBeNull();
  });

  it("reuses an audited unmatched classification across repeated scans and a later rematch", async () => {
    const f = await fixture({ send: false });
    let classifierCalls = 0;
    const aiClassifier = new OpenAIReplyClassifier(
      {
        run: async () => {
          classifierCalls += 1;
          return {
            responseId: `resp_rematch_${sequence}`,
            model: "gpt-5.6-luna",
            output: {
              category: "positive" as const,
              confidence: 0.93,
              reason: "The recipient is interested.",
            },
            sources: [],
            usage: null,
            costUsd: null,
          };
        },
      } as unknown as StructuredAIProvider,
      "gpt-5.6-luna",
    );
    const inReplyTo = `<rematch-${sequence}@provider.example>`;
    const input = {
      mailboxId: f.mailbox.id,
      providerMessageId: `audited-rematch-${sequence}`,
      inReplyTo,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Audited later match",
      body: "Yes, interested.",
      receivedAt: new Date("2026-08-11T10:32:00.000Z"),
    };
    const first = await ingestInboundMessage(db, aiClassifier, input);
    expect(first).toMatchObject({ ok: true, disposition: "unmatched" });
    if (!first.ok) return;
    expect(classifierCalls).toBe(1);
    const runId = first.reply.agentRunId;

    await reconcilePendingInboundRecords(db, aiClassifier, { limit: 200 });
    await reconcilePendingInboundRecords(db, aiClassifier, { limit: 200 });
    expect(classifierCalls).toBe(1);
    const [stillUnmatched] = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        eq(schema.inboundRecords.providerMessageId, input.providerMessageId),
      );
    expect(stillUnmatched).toMatchObject({
      status: "processed",
      classificationClaimId: null,
      classificationClaimedAt: null,
      lastAttemptAt: expect.any(Date),
    });

    await db
      .update(schema.messages)
      .set({ internetMessageId: inReplyTo, status: "sent" })
      .where(eq(schema.messages.id, f.message.id));
    await client.unsafe(`
      create function fail_reused_reply_update() returns trigger
      language plpgsql as $$
      begin
        raise exception 'injected downstream reply update failure';
      end;
      $$;
      create trigger fail_reused_reply_update_trigger
      before update on replies
      for each row execute function fail_reused_reply_update();
    `);
    try {
      expect(
        await reconcilePendingInboundRecords(db, aiClassifier, {
          limit: 200,
          now: new Date("2026-08-11T11:00:00.000Z"),
          classificationClaimTtlMs: 60_000,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ok: false, code: "DATABASE_ERROR" }),
        ]),
      );
    } finally {
      await client.unsafe(`
        drop trigger fail_reused_reply_update_trigger on replies;
        drop function fail_reused_reply_update();
      `);
    }
    expect(classifierCalls).toBe(1);
    const [preservedRun] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId!));
    expect(preservedRun).toMatchObject({
      status: "succeeded",
      error: null,
      completedAt: expect.any(Date),
    });
    expect(
      await reconcilePendingInboundRecords(db, aiClassifier, {
        limit: 200,
        now: new Date("2026-08-11T11:02:00.000Z"),
        classificationClaimTtlMs: 60_000,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, disposition: "processed" }),
      ]),
    );
    expect(classifierCalls).toBe(1);
    expect(
      await reconcilePendingInboundRecords(db, aiClassifier, { limit: 200 }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reply: expect.objectContaining({ id: first.reply.id }),
        }),
      ]),
    );
    const runs = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId!));
    expect(runs).toEqual([
      expect.objectContaining({
        status: "succeeded",
        completedAt: expect.any(Date),
      }),
    ]);
    expect(runs.some((run) => run.status === "started")).toBe(false);
    const [reply] = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.id, first.reply.id));
    expect(reply).toMatchObject({
      id: first.reply.id,
      enrollmentId: f.enrollment.id,
      agentRunId: runId,
      classification: "positive",
    });
  });

  it("finalizes a sanitized failed agent run when inbound AI classification fails", async () => {
    const f = await fixture();
    const aiClassifier = new OpenAIReplyClassifier(
      {
        run: async () => {
          throw new Error("sk-secret-classifier-failure");
        },
      } as unknown as StructuredAIProvider,
      "gpt-5.6-luna",
    );
    expect(
      await ingestInboundMessage(db, aiClassifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `ai-audit-failed-${sequence}`,
        outreachId: f.message.outreachId!,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Maybe",
        body: "Maybe later.",
        receivedAt: new Date("2026-08-11T10:31:00.000Z"),
      }),
    ).toEqual({ ok: false, code: "CLASSIFIER_ERROR" });
    const failedRuns = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "reply_classifier"));
    const failedRun = failedRuns.at(-1);
    expect(failedRun).toMatchObject({
      model: "gpt-5.6-luna",
      status: "failed",
      error: "Agent execution failed (Error)",
      output: null,
    });
    expect(failedRun?.completedAt).not.toBeNull();
    expect(JSON.stringify(failedRun)).not.toContain(
      "sk-secret-classifier-failure",
    );
  });

  it("takes over a stale processing classification claim and clears ownership", async () => {
    const f = await fixture();
    const providerMessageId = `stale-inbound-owner-${sequence}`;
    await db.insert(schema.inboundRecords).values({
      mailboxId: f.mailbox.id,
      providerMessageId,
      eventType: "message",
      payloadHash: `stale-inbound-hash-${sequence}`,
      status: "processing",
      classificationClaimId: "dead-worker",
      classificationClaimedAt: new Date("2026-08-11T09:00:00.000Z"),
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      metadata: {
        sender: `stale-${sequence}@outside.example`,
        recipient: f.mailbox.normalizedEmail,
        subject: "Recover stale processing",
        body: "Please recover",
      },
    });
    expect(
      await reconcilePendingInboundRecords(db, classifier, { limit: 10 }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, disposition: "unmatched" }),
      ]),
    );
    const [stored] = await db
      .select()
      .from(schema.inboundRecords)
      .where(eq(schema.inboundRecords.providerMessageId, providerMessageId));
    expect(stored).toMatchObject({
      status: "processed",
      classificationClaimId: null,
      classificationClaimedAt: null,
      lastAttemptAt: expect.any(Date),
    });
  });

  it("prioritizes failed recovery and rotates unmatched reconciliation fairly", async () => {
    const f = await fixture();
    const oldInbound = await db
      .insert(schema.inboundRecords)
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          mailboxId: f.mailbox.id,
          providerMessageId: `fair-old-${sequence}-${index}`,
          eventType: "message",
          payloadHash: `fair-old-hash-${sequence}-${index}`,
          status: "processed" as const,
          processedAt: new Date("2026-08-01T00:00:00.000Z"),
          receivedAt: new Date("2026-08-01T00:00:00.000Z"),
          metadata: {
            sender: `unknown-${index}@outside.example`,
            recipient: f.mailbox.normalizedEmail,
            subject: `Old unmatched ${index}`,
            body: "Unknown sender",
          },
        })),
      )
      .returning();
    await db.insert(schema.replies).values(
      oldInbound.map((inbound, index) => ({
        inboundRecordId: inbound.id,
        body: "Unknown sender",
        classification: "unknown" as const,
        confidence: "0.400",
        classificationReason: "unmatched",
        classifier: "fixture",
        sender: `unknown-${index}@outside.example`,
        subject: `Old unmatched ${index}`,
        terminatesSequence: false,
        receivedAt: new Date("2026-08-01T00:00:00.000Z"),
      })),
    );
    const [failedInbound] = await db
      .insert(schema.inboundRecords)
      .values({
        mailboxId: f.mailbox.id,
        providerMessageId: `fair-failed-${sequence}`,
        eventType: "message",
        payloadHash: `fair-failed-hash-${sequence}`,
        status: "failed",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
        metadata: {
          sender: "priority@outside.example",
          recipient: f.mailbox.normalizedEmail,
          subject: "Priority recovery",
          body: "Recover me first",
        },
      })
      .returning();
    const classifiedSubjects: string[] = [];
    const recordingClassifier: ReplyClassifier = {
      name: "fair-reconciler",
      async classify(input) {
        classifiedSubjects.push(input.subject);
        return { category: "unknown", confidence: 0.4, reason: "unmatched" };
      },
    };
    await reconcilePendingInboundRecords(db, recordingClassifier, { limit: 1 });
    expect(classifiedSubjects).toEqual(["Priority recovery"]);
    classifiedSubjects.length = 0;
    for (let scan = 0; scan < 6; scan += 1) {
      await reconcilePendingInboundRecords(db, recordingClassifier, {
        limit: 10,
      });
    }
    expect(
      classifiedSubjects.filter((subject) =>
        subject.startsWith("Old unmatched"),
      ),
    ).toEqual([]);
    const fairInboundIds = [
      ...oldInbound.map((row) => row.id),
      ...(failedInbound ? [failedInbound.id] : []),
    ];
    await db
      .delete(schema.replies)
      .where(inArray(schema.replies.inboundRecordId, fairInboundIds));
    await db
      .delete(schema.inboundRecords)
      .where(inArray(schema.inboundRecords.id, fairInboundIds));
  });

  it("clears unmatched reconciliation claims so bounded scans keep rotating", async () => {
    const f = await fixture();
    const inboundRows = await db
      .insert(schema.inboundRecords)
      .values(
        Array.from({ length: 12 }, (_, index) => ({
          mailboxId: f.mailbox.id,
          providerMessageId: `rotation-owner-${sequence}-${index}`,
          eventType: "message",
          payloadHash: `rotation-owner-hash-${sequence}-${index}`,
          status: "processed" as const,
          processedAt: new Date("2026-08-01T00:00:00.000Z"),
          receivedAt: new Date("2026-08-01T00:00:00.000Z"),
          metadata: {
            sender: `rotation-${index}@outside.example`,
            recipient: f.mailbox.normalizedEmail,
            subject: `Rotation unmatched ${index}`,
            body: "Still unmatched",
          },
        })),
      )
      .returning();
    await db.insert(schema.replies).values(
      inboundRows.map((inbound, index) => ({
        inboundRecordId: inbound.id,
        body: "Still unmatched",
        classification: "unknown" as const,
        confidence: "0.400",
        classificationReason: "unmatched",
        classifier: "fixture",
        sender: `rotation-${index}@outside.example`,
        subject: `Rotation unmatched ${index}`,
        terminatesSequence: false,
        receivedAt: new Date("2026-08-01T00:00:00.000Z"),
      })),
    );
    const classifiedSubjects: string[] = [];
    const recordingClassifier: ReplyClassifier = {
      name: "rotation-owner-probe",
      async classify(input) {
        classifiedSubjects.push(input.subject);
        return { category: "unknown", confidence: 0.4, reason: "unmatched" };
      },
    };
    const startedAt = new Date("2026-08-11T10:00:00.000Z");
    await reconcilePendingInboundRecords(db, recordingClassifier, {
      limit: 5,
      now: startedAt,
      classificationClaimTtlMs: 60_000,
    });
    const afterFirstBatch = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        inArray(
          schema.inboundRecords.id,
          inboundRows.map((row) => row.id),
        ),
      );
    expect(
      afterFirstBatch.every(
        (row) =>
          row.status === "processed" &&
          row.classificationClaimId === null &&
          row.classificationClaimedAt === null,
      ),
    ).toBe(true);
    for (let scan = 1; scan <= 3; scan += 1) {
      await reconcilePendingInboundRecords(db, recordingClassifier, {
        limit: 5,
        now: new Date(startedAt.getTime() + scan * 2 * 60_000),
        classificationClaimTtlMs: 60_000,
      });
    }
    expect(classifiedSubjects).toEqual([]);
    const rotationInboundIds = inboundRows.map((row) => row.id);
    await db
      .delete(schema.replies)
      .where(inArray(schema.replies.inboundRecordId, rotationInboundIds));
    await db
      .delete(schema.inboundRecords)
      .where(inArray(schema.inboundRecords.id, rotationInboundIds));
  });

  it.each([
    [false, "waiting"],
    [true, "manual_review"],
  ] as const)(
    "completes a nonterminal inbound hold with configured hold=%s",
    async (holdNonTerminal, expectedState) => {
      const f = await fixture({ holdNonTerminal });
      const due = f.enrollment.nextActionAt;
      const token = f.enrollment.nextActionToken;
      const result = await ingestInboundMessage(db, classifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `ooo-hold-${holdNonTerminal}-${sequence}`,
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Out of office",
        body: "Out of office until Monday",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      });
      expect(result).toMatchObject({ ok: true, disposition: "processed" });
      const [stored] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollment.id));
      expect(stored).toMatchObject({
        state: expectedState,
        inboundHoldCount: 0,
        nextActionAt: holdNonTerminal ? null : due,
        nextActionToken: holdNonTerminal ? null : token,
      });
      if (!holdNonTerminal) {
        const restored = await db
          .select()
          .from(schema.stateTransitions)
          .where(
            and(
              eq(schema.stateTransitions.entityType, "enrollment"),
              eq(schema.stateTransitions.entityId, f.enrollment.id),
              eq(
                schema.stateTransitions.reason,
                "inbound_nonterminal_reply_resumed",
              ),
            ),
          );
        expect(restored).toEqual([
          expect.objectContaining({
            fromState: "manual_review",
            toState: "waiting",
            metadata: expect.objectContaining({
              restoredNextActionAt: due?.toISOString(),
              restoredNextActionToken: token,
            }),
          }),
        ]);
      }
    },
  );

  it("restores a snapshotted sequence only after every pending inbound is classified", async () => {
    const f = await fixture({ holdNonTerminal: false });
    const releases: Array<() => void> = [];
    const slowClassifier: ReplyClassifier = {
      name: "slow-multiple-hold",
      async classify() {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { category: "unknown", confidence: 0.4, reason: "unclear" };
      },
    };
    const ingest = (suffix: string) =>
      ingestInboundMessage(db, slowClassifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `multiple-hold-${suffix}-${sequence}`,
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Checking in",
        body: "Thanks",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      });
    const first = ingest("first");
    while (releases.length < 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const second = ingest("second");
    while (releases.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const [held] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(held).toMatchObject({ state: "manual_review", inboundHoldCount: 2 });
    expect(
      await processFollowUpInvocation(
        db,
        f.provider,
        {
          enrollmentId: f.enrollment.id,
          expectedStep: 1,
          expectedVersionId: f.version.id,
          expectedDueAt: f.enrollment.nextActionAt!,
          expectedToken: f.enrollment.nextActionToken!,
        },
        { now: new Date("2026-08-11T11:01:00.000Z") },
      ),
    ).toMatchObject({ ok: false, code: "REPLY_PENDING" });
    releases[1]!();
    await second;
    const [onePending] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(onePending).toMatchObject({
      state: "manual_review",
      inboundHoldCount: 1,
      nextActionAt: null,
    });
    releases[0]!();
    await first;
    const [restored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(restored).toMatchObject({
      state: "waiting",
      inboundHoldCount: 0,
      nextActionAt: f.enrollment.nextActionAt,
      nextActionToken: f.enrollment.nextActionToken,
    });
  });

  it("recovers a follow-up after a crash immediately after its claim", async () => {
    const f = await fixture();
    const invocation = {
      enrollmentId: f.enrollment.id,
      expectedStep: 1,
      expectedVersionId: f.version.id,
      expectedDueAt: f.enrollment.nextActionAt!,
      expectedToken: f.enrollment.nextActionToken!,
    };
    expect(
      await processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:01:00.000Z"),
        crashAt: "after_claim",
      }),
    ).toMatchObject({ ok: false, code: "DATABASE_ERROR" });
    const recovered = await Promise.all([
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:02:00.000Z"),
      }),
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:02:00.000Z"),
      }),
    ]);
    expect(recovered.filter((result) => result.ok)).toEqual([
      expect.objectContaining({ disposition: "awaiting_review" }),
    ]);
    expect(recovered.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "IN_PROGRESS" }),
    ]);
  });

  it("recovers an automatic follow-up after approval but before send", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    const invocation = {
      enrollmentId: f.enrollment.id,
      expectedStep: 1,
      expectedVersionId: f.version.id,
      expectedDueAt: f.enrollment.nextActionAt!,
      expectedToken: f.enrollment.nextActionToken!,
    };
    expect(
      await processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:01:00.000Z"),
        crashAt: "after_approval",
      }),
    ).toMatchObject({ ok: false, code: "DATABASE_ERROR" });
    const recovered = await Promise.all([
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:02:00.000Z"),
      }),
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:02:00.000Z"),
      }),
    ]);
    expect(recovered.filter((result) => result.ok)).toEqual([
      expect.objectContaining({ disposition: "sent" }),
    ]);
    expect(recovered.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "IN_PROGRESS" }),
    ]);
    expect(f.provider.sendDraftCalls).toHaveLength(2);
  });

  it("grants one owned follow-up lease to concurrent automatic invocations", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    const invocation = {
      enrollmentId: f.enrollment.id,
      expectedStep: 1,
      expectedVersionId: f.version.id,
      expectedDueAt: f.enrollment.nextActionAt!,
      expectedToken: f.enrollment.nextActionToken!,
    };
    const results = await Promise.all([
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:01:00.000Z"),
      }),
      processFollowUpInvocation(db, f.provider, invocation, {
        now: new Date("2026-08-11T11:01:00.000Z"),
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "IN_PROGRESS" }),
    ]);
    expect(f.provider.sendDraftCalls).toHaveLength(2);
  });

  it("serializes a batch of slow automatic sends without stranding due work", async () => {
    await setPolicySettings();
    const fixtures = [];
    for (let index = 0; index < 5; index += 1) {
      fixtures.push(await fixture({ automatic: true }));
    }
    class SlowProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return super.sendDraft(input);
      }
    }
    const provider = new SlowProvider();
    const results = await Promise.all(
      fixtures.map((f) =>
        processFollowUpInvocation(
          db,
          provider,
          {
            enrollmentId: f.enrollment.id,
            expectedStep: 1,
            expectedVersionId: f.version.id,
            expectedDueAt: f.enrollment.nextActionAt!,
            expectedToken: f.enrollment.nextActionToken!,
          },
          {
            now: new Date("2026-08-11T12:00:00.000Z"),
            clock: () => new Date("2026-08-11T12:00:00.000Z"),
          },
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(provider.sendDraftCalls).toHaveLength(5);
    const [{ count }] = await client<[{ count: number }]>`
      select count(*)::int as count from pg_locks where locktype = 'advisory'
    `;
    expect(count).toBe(0);
  });

  it("gives lock contention a short recoverable retry instead of a long delay", async () => {
    await setPolicySettings();
    const first = await fixture({ automatic: true });
    const second = await fixture({ automatic: true });
    class VerySlowProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        return super.sendDraft(input);
      }
    }
    const provider = new VerySlowProvider();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const results = await Promise.all(
      [first, second].map((f) =>
        processFollowUpInvocation(
          db,
          provider,
          {
            enrollmentId: f.enrollment.id,
            expectedStep: 1,
            expectedVersionId: f.version.id,
            expectedDueAt: f.enrollment.nextActionAt!,
            expectedToken: f.enrollment.nextActionToken!,
          },
          { now, clock: () => now },
        ),
      ),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, disposition: "sent" }),
        expect.objectContaining({
          ok: false,
          code: "SEND_BLOCKED",
          blockCode: "IN_PROGRESS",
        }),
      ]),
    );
    const retrying = results[0]?.ok ? second : first;
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, retrying.enrollment.id));
    expect(stored).toMatchObject({
      state: "waiting",
      nextActionAt: new Date("2026-08-11T12:00:05.000Z"),
      workflowClaimId: null,
    });
  });

  it("uses a live clock for the automatic follow-up final policy", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    await setPolicySettings({
      timezone: "UTC",
      workingStartMinute: 0,
      workingEndMinute: 60,
    });
    const times = [
      new Date("2026-08-12T00:59:00.000Z"),
      new Date("2026-08-12T01:00:00.000Z"),
    ];
    expect(
      await processFollowUpInvocation(
        db,
        f.provider,
        {
          enrollmentId: f.enrollment.id,
          expectedStep: 1,
          expectedVersionId: f.version.id,
          expectedDueAt: f.enrollment.nextActionAt!,
          expectedToken: f.enrollment.nextActionToken!,
        },
        {
          now: new Date("2026-08-12T00:59:00.000Z"),
          clock: () => times.shift() ?? new Date("2026-08-12T01:00:00.000Z"),
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "SEND_BLOCKED",
      blockCode: "OUTSIDE_WORKING_HOURS",
    });
    expect(f.provider.deliveries).toHaveLength(1);
    await setPolicySettings();
  });

  it("falls through an unmatched outreach id to a valid in-reply-to", async () => {
    const f = await fixture();
    expect(
      await ingestInboundMessage(db, classifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `fallback-thread-${sequence}`,
        outreachId: "not-a-real-outreach-id",
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Interested",
        body: "Yes, interested",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      }),
    ).toMatchObject({ ok: true, disposition: "processed" });
  });

  it("does not terminate a threaded message from an unrelated sender", async () => {
    const f = await fixture();
    expect(
      await ingestInboundMessage(db, classifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `forwarded-thread-${sequence}`,
        inReplyTo: f.message.internetMessageId,
        sender: `forwarder-${sequence}@example.net`,
        recipient: f.mailbox.normalizedEmail,
        subject: "Interested",
        body: "Yes, interested",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      }),
    ).toMatchObject({ ok: true, disposition: "ambiguous" });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored?.state).toBe("waiting");
  });

  it("preserves an existing terminal enrollment while persisting a reply", async () => {
    const f = await fixture();
    await stopEnrollment(db, {
      enrollmentId: f.enrollment.id,
      actor: "operator",
    });
    expect(
      await ingestInboundMessage(db, classifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `terminal-thread-${sequence}`,
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.normalizedEmail,
        subject: "Interested",
        body: "Yes, interested",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      }),
    ).toMatchObject({ ok: true, disposition: "processed" });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored).toMatchObject({
      state: "stopped",
      stopReason: "manual_stop",
    });
  });

  it("pauses only active campaigns and audits resume", async () => {
    const f = await fixture({ send: false });
    expect(
      await pauseCampaign(db, { campaignId: f.campaign.id, actor: "operator" }),
    ).toMatchObject({ ok: true, disposition: "paused" });
    expect(
      await resumeCampaign(db, {
        campaignId: f.campaign.id,
        actor: "operator",
      }),
    ).toMatchObject({ ok: true, disposition: "resumed" });
    const events = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, f.campaign.id));
    expect(events.map((row) => row.event)).toContain("campaign.resumed");
  });

  it("reprocesses one previously unmatched inbound row after threading identity appears", async () => {
    const f = await fixture({ send: false });
    const input = {
      mailboxId: f.mailbox.id,
      providerMessageId: `late-thread-unmatched-${sequence}`,
      inReplyTo: `<late-thread-${sequence}@provider.example>`,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, interested",
      receivedAt: new Date("2026-08-11T10:00:01.000Z"),
    };
    const first = await ingestInboundMessage(db, classifier, input);
    expect(first).toMatchObject({ ok: true, disposition: "unmatched" });
    await db
      .update(schema.messages)
      .set({ internetMessageId: input.inReplyTo, status: "sent" })
      .where(eq(schema.messages.id, f.message.id));
    const reconciled = await reconcilePendingInboundRecords(db, classifier);
    expect(reconciled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          disposition: "processed",
          reply: expect.objectContaining({
            id: first.ok ? first.reply.id : undefined,
          }),
        }),
      ]),
    );
    expect(await ingestInboundMessage(db, classifier, input)).toMatchObject({
      ok: true,
      disposition: "existing",
      reply: { id: first.ok ? first.reply.id : undefined },
    });
    const inboundRows = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        eq(schema.inboundRecords.providerMessageId, input.providerMessageId),
      );
    const replyRows = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.inboundRecordId, inboundRows[0]!.id));
    const auditRows = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, inboundRows[0]!.id))
      .orderBy(
        asc(schema.workflowEvents.createdAt),
        asc(schema.workflowEvents.id),
      );
    expect(inboundRows).toHaveLength(1);
    expect(replyRows).toHaveLength(1);
    // created_at is assigned at each transaction boundary and is not a causal
    // sequence number. Verify the durable audit facts without depending on a
    // random UUID tie-break when timestamps share the same observable instant.
    expect(auditRows.map((row) => row.event)).toEqual(
      expect.arrayContaining(["inbound.unmatched", "inbound.reply_processed"]),
    );
    expect(auditRows).toHaveLength(2);
  });

  it("reprocesses one previously ambiguous inbound row after ambiguity resolves", async () => {
    const sharedConversation = `late-thread-ambiguous-${sequence}`;
    const target = await fixture();
    const other = await fixture({ mailboxId: target.mailbox.id });
    await db
      .update(schema.messages)
      .set({ conversationId: sharedConversation })
      .where(
        inArray(schema.messages.id, [target.message.id, other.message.id]),
      );
    const input = {
      mailboxId: target.mailbox.id,
      providerMessageId: `late-ambiguous-inbound-${sequence}`,
      conversationId: sharedConversation,
      sender: target.recipient,
      recipient: target.mailbox.normalizedEmail,
      subject: "Interested",
      body: "Yes, interested",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    };
    const first = await ingestInboundMessage(db, classifier, input);
    expect(first).toMatchObject({ ok: true, disposition: "ambiguous" });
    await db
      .update(schema.messages)
      .set({ conversationId: `resolved-away-${sequence}` })
      .where(eq(schema.messages.id, other.message.id));
    expect(await ingestInboundMessage(db, classifier, input)).toMatchObject({
      ok: true,
      disposition: "processed",
      reply: {
        id: first.ok ? first.reply.id : undefined,
        enrollmentId: target.enrollment.id,
      },
    });
  });

  it("schedules the next immutable step when a multi-step delivery was confirmed before recovery", async () => {
    await setPolicySettings();
    const f = await fixture({ send: false });
    const provider = new MockMailProvider({ confirmation: "manual" });
    const draft = await provider.createDraft({
      outreachId: f.message.outreachId!,
      mailboxId: f.mailbox.id,
      sender: f.mailbox.normalizedEmail,
      recipient: f.recipient,
      subject: f.message.subject,
      body: f.message.body,
      headers: f.message.headers,
    });
    await provider.sendDraft({
      draftId: draft.draftId,
      outreachId: f.message.outreachId!,
      mailboxId: f.mailbox.id,
    });
    provider.confirm(f.message.outreachId!, f.mailbox.id);
    expect(
      await sendApprovedMessage(db, provider, { messageId: f.message.id }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored).toMatchObject({
      state: "waiting",
      currentStep: 1,
      stopReason: null,
    });
    expect(stored?.nextActionToken).toMatch(/^followup_/);
  });

  it("recovers overdue manual follow-ups without requeueing review-ready work", async () => {
    const f = await fixture();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const due = await findDueEnrollments(db, { now, limit: 20 });
    expect(due.map((row) => row.enrollmentId)).toContain(f.enrollment.id);
    const input = {
      enrollmentId: f.enrollment.id,
      expectedStep: 1,
      expectedVersionId: f.version.id,
      expectedDueAt: f.enrollment.nextActionAt!,
      expectedToken: f.enrollment.nextActionToken!,
    };
    const processed = await processFollowUpInvocation(db, f.provider, input, {
      now,
    });
    expect(processed).toMatchObject({
      ok: true,
      disposition: "awaiting_review",
    });
    const [proposal] = await db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.enrollmentId, f.enrollment.id),
          eq(schema.messages.stepIndex, 1),
        ),
      );
    expect(proposal).toMatchObject({
      status: "proposed",
      recipient: f.recipient,
    });
    expect(
      (await findDueEnrollments(db, { now })).some(
        (row) => row.enrollmentId === f.enrollment.id,
      ),
    ).toBe(false);
    expect(
      await processFollowUpInvocation(db, f.provider, input, { now }),
    ).toMatchObject({ ok: true, disposition: "awaiting_review" });
  });

  it("automatically approves and sends only when immutable config enables it", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    const result = await processFollowUpInvocation(
      db,
      f.provider,
      {
        enrollmentId: f.enrollment.id,
        expectedStep: 1,
        expectedVersionId: f.version.id,
        expectedDueAt: f.enrollment.nextActionAt!,
        expectedToken: f.enrollment.nextActionToken!,
      },
      { now: new Date("2026-08-11T12:00:00Z") },
    );
    expect(result).toMatchObject({ ok: true, disposition: "sent" });
    expect(f.provider.deliveries).toHaveLength(2);
    const [enrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(enrollment).toMatchObject({
      state: "completed",
      stopReason: "sequence_complete",
      nextActionAt: null,
    });
  });

  it("recovers an overdue automatic action through scheduler reconciliation", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    const results = await reconcileDueFollowUps(db, f.provider, {
      now: new Date("2026-08-11T12:00:00Z"),
      limit: 100,
    });
    expect(results).toContainEqual(
      expect.objectContaining({ ok: true, disposition: "sent" }),
    );
    expect(f.provider.deliveries).toHaveLength(2);
  });

  it("reschedules an automatic follow-up provider failure for recovery", async () => {
    await setPolicySettings();
    const f = await fixture({ automatic: true });
    class FailingProvider extends MockMailProvider {
      override async createDraft(): Promise<never> {
        throw new Error("transient provider failure");
      }
    }
    const result = await processFollowUpInvocation(
      db,
      new FailingProvider(),
      {
        enrollmentId: f.enrollment.id,
        expectedStep: 1,
        expectedVersionId: f.version.id,
        expectedDueAt: f.enrollment.nextActionAt!,
        expectedToken: f.enrollment.nextActionToken!,
      },
      { now: new Date("2026-08-11T12:00:00Z") },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "SEND_BLOCKED",
      blockCode: "PROVIDER_ERROR",
    });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored).toMatchObject({ state: "waiting" });
    expect(stored?.nextActionAt).toEqual(new Date("2026-08-11T12:15:00.000Z"));
  });

  it.each([
    ["campaign", "CAMPAIGN_INACTIVE"],
    ["email", "RECIPIENT_SUPPRESSED"],
    ["domain", "COMPANY_SUPPRESSED"],
  ] as const)(
    "rechecks %s policy when a scheduled follow-up wakes",
    async (kind, code) => {
      await setPolicySettings();
      const f = await fixture({ automatic: true });
      if (kind === "campaign") {
        await db
          .update(schema.campaigns)
          .set({ status: "paused" })
          .where(eq(schema.campaigns.id, f.campaign.id));
      } else {
        await addSuppression(db, {
          scope: kind,
          value: kind === "email" ? f.recipient : f.account.domain!,
          reason: "manual",
          actor: "operator",
        });
      }
      const result = await processFollowUpInvocation(
        db,
        f.provider,
        {
          enrollmentId: f.enrollment.id,
          expectedStep: 1,
          expectedVersionId: f.version.id,
          expectedDueAt: f.enrollment.nextActionAt!,
          expectedToken: f.enrollment.nextActionToken!,
        },
        { now: new Date("2026-08-11T12:00:00Z") },
      );
      expect(result).toMatchObject({ ok: false, code });
      expect(f.provider.deliveries).toHaveLength(1);
      const [stored] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollment.id));
      if (kind === "campaign") {
        expect(stored).toMatchObject({ state: "waiting" });
      } else {
        expect(stored).toMatchObject({
          state: "stopped",
          stopReason:
            kind === "email" ? "recipient_suppressed" : "company_suppressed",
          nextActionAt: null,
          nextActionToken: null,
        });
      }
    },
  );

  it("lets a reply immediately before a due follow-up win", async () => {
    const f = await fixture({ automatic: true });
    const inbound = await ingestInboundMessage(db, classifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `inbound-${sequence}`,
      providerNotificationId: `notification-${sequence}`,
      conversationId: f.message.conversationId,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.email,
      subject: "Re: hello",
      body: "Yes, let's schedule a call",
      receivedAt: new Date("2026-08-11T10:59:59Z"),
    });
    expect(inbound).toMatchObject({ ok: true, disposition: "processed" });
    expect(
      await processFollowUpInvocation(
        db,
        f.provider,
        {
          enrollmentId: f.enrollment.id,
          expectedStep: 1,
          expectedVersionId: f.version.id,
          expectedDueAt: f.enrollment.nextActionAt!,
          expectedToken: f.enrollment.nextActionToken!,
        },
        { now: new Date("2026-08-11T11:00:00Z") },
      ),
    ).toMatchObject({ ok: false, code: "STALE_INVOCATION" });
    expect(f.provider.deliveries).toHaveLength(1);
  });

  it("persists an audited manual stop that makes a waking invocation stale", async () => {
    const f = await fixture({ automatic: true });
    expect(
      await stopEnrollment(db, {
        enrollmentId: f.enrollment.id,
        actor: "operator",
      }),
    ).toMatchObject({ ok: true, disposition: "stopped" });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(stored).toMatchObject({
      state: "stopped",
      stopReason: "manual_stop",
      nextActionAt: null,
      nextActionToken: null,
    });
    expect(
      await processFollowUpInvocation(
        db,
        f.provider,
        {
          enrollmentId: f.enrollment.id,
          expectedStep: 1,
          expectedVersionId: f.version.id,
          expectedDueAt: f.enrollment.nextActionAt!,
          expectedToken: f.enrollment.nextActionToken!,
        },
        { now: new Date("2026-08-11T12:00:00Z") },
      ),
    ).toMatchObject({ ok: false, code: "STALE_INVOCATION" });
  });

  it.each([
    ["Please unsubscribe me", null, "opted_out", "unsubscribe", true],
    ["Delivery failed", "hard", "bounced", "hard_bounce", true],
    ["Mailbox full", "soft", "manual_review", null, false],
  ] as const)(
    "applies terminal and bounce policy for %s",
    async (body, bounceKind, state, stopReason, suppressed) => {
      const f = await fixture();
      const result = await ingestInboundMessage(db, classifier, {
        mailboxId: f.mailbox.id,
        providerMessageId: `policy-inbound-${sequence}-${bounceKind ?? "reply"}`,
        conversationId: f.message.conversationId,
        inReplyTo: f.message.internetMessageId,
        sender: f.recipient,
        recipient: f.mailbox.email,
        subject: bounceKind ? "Delivery status notification" : "Re: hello",
        body,
        bounceKind,
        bouncedRecipient: bounceKind ? f.recipient : undefined,
        receivedAt: new Date("2026-08-11T10:30:00Z"),
      });
      expect(result).toMatchObject({ ok: true });
      const [stored] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollment.id));
      expect(stored).toMatchObject({ state, stopReason, nextActionAt: null });
      const entries = await listSuppressions(db, {});
      expect(
        entries.some((entry) => entry.normalizedValue === f.recipient),
      ).toBe(suppressed);
    },
  );

  it("suppresses the failed recipient rather than the DSN sender on hard bounce", async () => {
    const f = await fixture();
    const result = await ingestInboundMessage(db, classifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `dsn-${sequence}`,
      conversationId: f.message.conversationId,
      inReplyTo: f.message.internetMessageId,
      sender: "postmaster@example.net",
      recipient: f.mailbox.email,
      bouncedRecipient: f.recipient,
      subject: "Delivery status notification",
      body: "Recipient does not exist",
      bounceKind: "hard",
      receivedAt: new Date("2026-08-11T10:30:00Z"),
    });
    expect(result).toMatchObject({ ok: true, disposition: "processed" });
    const entries = await listSuppressions(db, { scope: "email" });
    expect(entries.map((entry) => entry.normalizedValue)).toContain(
      f.recipient,
    );
    expect(entries.map((entry) => entry.normalizedValue)).not.toContain(
      "postmaster@example.net",
    );
  });

  it("deduplicates webhook/delta records without repeating side effects", async () => {
    const f = await fixture();
    const input = {
      mailboxId: f.mailbox.id,
      providerMessageId: `duplicate-inbound-${sequence}`,
      providerNotificationId: `duplicate-notification-${sequence}`,
      conversationId: f.message.conversationId,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.email,
      subject: "Re: hello",
      body: "No thank you",
      receivedAt: new Date("2026-08-11T10:30:00Z"),
    };
    expect(await ingestInboundMessage(db, classifier, input)).toMatchObject({
      ok: true,
      disposition: "processed",
    });
    expect(await ingestInboundMessage(db, classifier, input)).toMatchObject({
      ok: true,
      disposition: "existing",
    });
    const stored = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.enrollmentId, f.enrollment.id));
    expect(stored).toHaveLength(1);
  });

  it("scopes provider idempotency identities to their mailbox", async () => {
    const a = await fixture();
    const b = await fixture();
    const providerMessageId = `shared-provider-message-${sequence}`;
    const inputFor = (f: typeof a) => ({
      mailboxId: f.mailbox.id,
      providerMessageId,
      conversationId: f.message.conversationId,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.email,
      subject: "Re: hello",
      body: "Noted",
      receivedAt: new Date("2026-08-11T10:30:00Z"),
    });
    expect(
      await ingestInboundMessage(db, classifier, inputFor(a)),
    ).toMatchObject({
      ok: true,
      disposition: "processed",
      reply: { enrollmentId: a.enrollment.id },
    });
    expect(
      await ingestInboundMessage(db, classifier, inputFor(b)),
    ).toMatchObject({
      ok: true,
      disposition: "processed",
      reply: { enrollmentId: b.enrollment.id },
    });
    expect(
      await ingestInboundMessage(db, classifier, inputFor(b)),
    ).toMatchObject({
      ok: true,
      disposition: "existing",
      reply: { enrollmentId: b.enrollment.id },
    });
  });

  it("scopes outbound provider draft and message identities to their mailbox", async () => {
    const a = await fixture({ send: false });
    const b = await fixture({ send: false });
    await db
      .update(schema.messages)
      .set({
        providerDraftId: "shared-provider-draft",
        providerMessageId: "shared-provider-message",
      })
      .where(eq(schema.messages.id, a.message.id));
    await expect(
      db
        .update(schema.messages)
        .set({
          providerDraftId: "shared-provider-draft",
          providerMessageId: "shared-provider-message",
        })
        .where(eq(schema.messages.id, b.message.id)),
    ).resolves.toBeDefined();
    const stored = await db
      .select({ mailboxId: schema.messages.mailboxId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.providerDraftId, "shared-provider-draft"),
          eq(schema.messages.providerMessageId, "shared-provider-message"),
        ),
      );
    expect(new Set(stored.map((row) => row.mailboxId))).toEqual(
      new Set([a.mailbox.id, b.mailbox.id]),
    );
    await expect(
      db
        .update(schema.messages)
        .set({ mailboxId: b.mailbox.id })
        .where(eq(schema.messages.id, a.message.id)),
    ).rejects.toBeDefined();
  });

  it("does not reconcile a provider identity from another mailbox", async () => {
    await setPolicySettings();
    const target = await fixture({ send: false });
    const other = await fixture({ send: false });
    const provider = new MockMailProvider();
    const wrongDraft = await provider.createDraft({
      outreachId: target.message.outreachId!,
      mailboxId: other.mailbox.id,
      sender: other.mailbox.normalizedEmail,
      recipient: target.recipient,
      subject: target.message.subject,
      body: target.message.body,
      headers: target.message.headers,
    });
    expect(
      await provider.reconcile({
        outreachId: target.message.outreachId!,
        draftId: wrongDraft.draftId,
        mailboxId: target.mailbox.id,
      }),
    ).toBeNull();
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: target.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.deliveries).toEqual([
      expect.objectContaining({ mailboxId: target.mailbox.id }),
    ]);
  });

  it("persists ambiguous inbound mail without attaching it", async () => {
    const sharedConversation = `ambiguous-conversation-${sequence}`;
    const a = await fixture();
    const b = await fixture({ mailboxId: a.mailbox.id });
    await db
      .update(schema.messages)
      .set({ conversationId: sharedConversation })
      .where(eq(schema.messages.id, a.message.id));
    await db
      .update(schema.messages)
      .set({ conversationId: sharedConversation })
      .where(eq(schema.messages.id, b.message.id));
    const result = await ingestInboundMessage(db, classifier, {
      mailboxId: a.mailbox.id,
      providerMessageId: `ambiguous-inbound-${sequence}`,
      conversationId: sharedConversation,
      sender: "unknown@example.com",
      recipient: a.mailbox.email,
      subject: "Re: hello",
      body: "Noted",
      receivedAt: new Date("2026-08-11T10:30:00Z"),
    });
    expect(result).toMatchObject({ ok: true, disposition: "ambiguous" });
  });

  it.each([
    [
      "outreach",
      (message: typeof schema.messages.$inferSelect) => ({
        outreachId: message.outreachId,
      }),
    ],
    [
      "internet message",
      (message: typeof schema.messages.$inferSelect) => ({
        inReplyTo: message.internetMessageId,
      }),
    ],
    [
      "references",
      (message: typeof schema.messages.$inferSelect) => ({
        references: [message.internetMessageId!],
      }),
    ],
    [
      "conversation",
      (message: typeof schema.messages.$inferSelect) => ({
        conversationId: message.conversationId,
      }),
    ],
  ])(
    "never matches a %s identifier across mailboxes",
    async (_name, identifier) => {
      await setPolicySettings();
      const target = await fixture();
      const otherMailbox = await fixture();
      const result = await ingestInboundMessage(db, classifier, {
        mailboxId: otherMailbox.mailbox.id,
        providerMessageId: `cross-mailbox-${sequence}`,
        ...identifier(target.message),
        sender: target.recipient,
        recipient: otherMailbox.mailbox.normalizedEmail,
        subject: "Interested",
        body: "Yes, interested",
        receivedAt: new Date("2026-08-11T10:30:00.000Z"),
      });
      expect(result).toMatchObject({ ok: true, disposition: "unmatched" });
      const [stored] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, target.enrollment.id));
      expect(stored).toMatchObject({ state: "waiting", stopReason: null });
    },
  );

  it("globally suppresses an unmatched explicit unsubscribe without stopping an unrelated enrollment", async () => {
    const unrelated = await fixture({ send: false });
    const sender = `optout-${sequence}@unmatched.example`;
    const input = {
      mailboxId: unrelated.mailbox.id,
      providerMessageId: `unmatched-optout-${sequence}`,
      sender,
      recipient: unrelated.mailbox.normalizedEmail,
      subject: "Unsubscribe",
      body: "Please unsubscribe me",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    };
    const result = await ingestInboundMessage(db, classifier, input);
    expect(result).toMatchObject({ ok: true, disposition: "unmatched" });
    expect(await ingestInboundMessage(db, classifier, input)).toMatchObject({
      ok: true,
      disposition: "unmatched",
    });
    const [entry] = await db
      .select()
      .from(schema.suppressionEntries)
      .where(eq(schema.suppressionEntries.normalizedValue, sender));
    expect(entry).toMatchObject({ reason: "unsubscribe" });
    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, entry!.id));
    expect(transitions).toEqual([
      expect.objectContaining({
        entityType: "suppression",
        reason: "unsubscribe",
      }),
    ]);
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, unrelated.enrollment.id));
    expect(stored?.state).not.toBe("opted_out");
  });

  it("suppresses only an explicit bounced recipient on an unmatched hard-bounce signal", async () => {
    const unrelated = await fixture({ send: false });
    const bouncedRecipient = `explicit-bounce-${sequence}@unmatched.example`;
    const dsnSender = "postmaster@mailer.example";
    const result = await ingestInboundMessage(db, classifier, {
      mailboxId: unrelated.mailbox.id,
      providerMessageId: `unmatched-hard-bounce-${sequence}`,
      sender: dsnSender,
      recipient: unrelated.mailbox.normalizedEmail,
      subject: "Delivery failed",
      body: "Recipient rejected",
      bounceKind: "hard",
      bouncedRecipient,
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    });
    expect(result).toMatchObject({ ok: true, disposition: "unmatched" });
    const entries = await db
      .select()
      .from(schema.suppressionEntries)
      .where(
        inArray(schema.suppressionEntries.normalizedValue, [
          bouncedRecipient,
          dsnSender,
        ]),
      );
    expect(entries).toEqual([
      expect.objectContaining({
        normalizedValue: bouncedRecipient,
        reason: "hard_bounce",
      }),
    ]);
  });

  it("normalizes, idempotently adds, lists, removes, and audits suppression", async () => {
    const added = await addSuppression(db, {
      scope: "email",
      value: " Operator@BÜCHER.example ",
      reason: "manual",
      actor: "operator",
    });
    expect(added).toMatchObject({
      ok: true,
      entry: { normalizedValue: "operator@xn--bcher-kva.example" },
    });
    expect(
      await addSuppression(db, {
        scope: "email",
        value: "operator@xn--bcher-kva.example",
        reason: "manual",
        actor: "operator",
      }),
    ).toMatchObject({ ok: true, disposition: "existing" });
    if (!added.ok) return;
    expect(
      await removeSuppression(db, { id: added.entry.id, actor: "operator" }),
    ).toMatchObject({
      ok: true,
      disposition: "removed",
    });
  });

  it("upgrades automatic opt-out provenance and requires confirmed removal", async () => {
    const f = await fixture();
    const manual = await addSuppression(db, {
      scope: "email",
      value: f.recipient,
      reason: "manual",
      actor: "operator",
    });
    if (!manual.ok) throw new Error(manual.code);
    await ingestInboundMessage(db, classifier, {
      mailboxId: f.mailbox.id,
      providerMessageId: `upgrade-optout-${sequence}`,
      inReplyTo: f.message.internetMessageId,
      sender: f.recipient,
      recipient: f.mailbox.normalizedEmail,
      subject: "Unsubscribe",
      body: "Please unsubscribe me",
      receivedAt: new Date("2026-08-11T10:30:00.000Z"),
    });
    const [upgraded] = await db
      .select()
      .from(schema.suppressionEntries)
      .where(eq(schema.suppressionEntries.id, manual.entry.id));
    expect(upgraded).toMatchObject({ reason: "unsubscribe" });
    expect(
      await removeSuppression(db, { id: manual.entry.id, actor: "operator" }),
    ).toEqual({ ok: false, code: "REMOVAL_REQUIRES_CONFIRMATION" });
    expect(
      await removeSuppression(db, {
        id: manual.entry.id,
        actor: "operator",
        confirmedResubscription: true,
        justification: "Recipient explicitly opted back in",
      }),
    ).toEqual({ ok: true, disposition: "removed" });
  });

  it("uses deterministic suppression precedence without duplicate upgrade audit", async () => {
    const value = `precedence-${sequence}@example.com`;
    const reasons = ["manual", "hard_bounce", "legal", "unsubscribe"] as const;
    let id = "";
    for (const reason of reasons) {
      const result = await addSuppression(db, {
        scope: "email",
        value,
        reason,
        actor: "operator",
      });
      if (!result.ok) throw new Error(result.code);
      id = result.entry.id;
    }
    await addSuppression(db, {
      scope: "email",
      value,
      reason: "hard_bounce",
      actor: "operator",
    });
    await addSuppression(db, {
      scope: "email",
      value,
      reason: "unsubscribe",
      actor: "operator",
    });
    const [entry] = await db
      .select()
      .from(schema.suppressionEntries)
      .where(eq(schema.suppressionEntries.id, id));
    expect(entry).toMatchObject({ reason: "unsubscribe" });
    const upgrades = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "suppression"),
          eq(schema.stateTransitions.entityId, id),
          eq(schema.stateTransitions.reason, "suppression_provenance_upgraded"),
        ),
      );
    expect(upgrades).toHaveLength(3);
    expect(
      await removeSuppression(db, {
        id,
        actor: "operator",
        verifiedAddressOverride: true,
        justification: "Address now verifies",
      }),
    ).toEqual({ ok: false, code: "REMOVAL_REQUIRES_CONFIRMATION" });
  });

  it.each([
    ["paused", "CAMPAIGN_INACTIVE"],
    ["manual", "ENROLLMENT_INACTIVE"],
  ] as const)(
    "blocks %s state before provider delivery",
    async (kind, code) => {
      await setPolicySettings();
      const f = await fixture({ send: false });
      if (kind === "paused") {
        await db
          .update(schema.campaigns)
          .set({ status: "paused" })
          .where(eq(schema.campaigns.id, f.campaign.id));
      } else {
        await db
          .update(schema.enrollments)
          .set({
            state: "stopped",
            stopReason: "manual_stop",
            nextActionAt: null,
          })
          .where(eq(schema.enrollments.id, f.enrollment.id));
      }
      expect(
        await sendApprovedMessage(
          db,
          f.provider,
          { messageId: f.message.id },
          { clock: () => sentAt },
        ),
      ).toMatchObject({ ok: false, code });
      expect(f.provider.deliveries).toHaveLength(0);
    },
  );

  it.each([
    ["email", "RECIPIENT_SUPPRESSED"],
    ["domain", "COMPANY_SUPPRESSED"],
  ] as const)(
    "checks %s suppression in the final send transaction",
    async (scope, code) => {
      await setPolicySettings();
      const f = await fixture({ send: false });
      await addSuppression(db, {
        scope,
        value: scope === "email" ? f.recipient : f.account.domain!,
        reason: "manual",
        actor: "operator",
      });
      expect(
        await sendApprovedMessage(
          db,
          f.provider,
          { messageId: f.message.id },
          { clock: () => sentAt },
        ),
      ).toMatchObject({ ok: false, code });
      expect(f.provider.deliveries).toHaveLength(0);
    },
  );

  it("enforces timezone-aware working hours from PostgreSQL settings", async () => {
    await setPolicySettings({
      timezone: "Europe/Paris",
      workingDays: [1, 2, 3, 4, 5],
      workingStartMinute: 9 * 60,
      workingEndMinute: 17 * 60,
    });
    const f = await fixture({ send: false });
    expect(
      await sendApprovedMessage(
        db,
        f.provider,
        { messageId: f.message.id },
        { clock: () => new Date("2026-08-11T05:00:00Z") },
      ),
    ).toMatchObject({ ok: false, code: "OUTSIDE_WORKING_HOURS" });
  });

  it.each([
    [{ mailboxDailyCap: 1 }, "MAILBOX_DAILY_CAP_REACHED"],
    [
      { mailboxDailyCap: 100, campaignDailyCap: 1 },
      "CAMPAIGN_DAILY_CAP_REACHED",
    ],
    [
      {
        mailboxDailyCap: 100,
        campaignDailyCap: 100,
        mailboxMinimumDelaySeconds: 3_600,
      },
      "MAILBOX_MINIMUM_DELAY",
    ],
    [
      {
        mailboxDailyCap: 100,
        campaignDailyCap: 100,
        mailboxMinimumDelaySeconds: 0,
        contactMinimumDelayMinutes: 60,
      },
      "CONTACT_MINIMUM_DELAY",
    ],
  ] as const)(
    "enforces persisted cap/delay policy: %s",
    async (settings, code) => {
      await setPolicySettings(settings);
      const f = await fixture({
        send: false,
        campaignDailyCap: code === "CAMPAIGN_DAILY_CAP_REACHED" ? 1 : 100,
      });
      await db.insert(schema.messages).values({
        enrollmentId: f.enrollment.id,
        stepIndex: 99,
        direction: "outbound",
        outreachId: `history_${sequence}_${code}`,
        subject: "History",
        body: "History",
        recipient: f.recipient,
        contactAccountId: f.contact.accountId,
        employmentVersion: f.contact.employmentVersion,
        status: "sent",
        sentAt: new Date(sentAt.getTime() - 60_000),
      });
      expect(
        await sendApprovedMessage(
          db,
          f.provider,
          { messageId: f.message.id },
          { clock: () => sentAt },
        ),
      ).toMatchObject({ ok: false, code });
    },
  );

  it("serializes concurrent cap reservations so only one provider send can win", async () => {
    await setPolicySettings({ mailboxDailyCap: 1 });
    const a = await fixture({ send: false });
    const b = await fixture({ send: false, mailboxId: a.mailbox.id });
    const results = await Promise.all([
      sendApprovedMessage(
        db,
        a.provider,
        { messageId: a.message.id },
        { clock: () => sentAt },
      ),
      sendApprovedMessage(
        db,
        b.provider,
        { messageId: b.message.id },
        { clock: () => sentAt },
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "IN_PROGRESS" }),
    ]);
    expect(a.provider.deliveries.length + b.provider.deliveries.length).toBe(1);
  });

  it("uses send-attempt reservations for concurrent mailbox pacing", async () => {
    await setPolicySettings({
      mailboxDailyCap: 100,
      mailboxMinimumDelaySeconds: 60,
    });
    const a = await fixture({ send: false });
    const b = await fixture({ send: false, mailboxId: a.mailbox.id });
    const results = await Promise.all([
      sendApprovedMessage(
        db,
        a.provider,
        { messageId: a.message.id },
        { clock: () => sentAt },
      ),
      sendApprovedMessage(
        db,
        b.provider,
        { messageId: b.message.id },
        { clock: () => sentAt },
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: "IN_PROGRESS" }),
    ]);
  });

  it("enforces cross-campaign contact cooldown and professional relevance", async () => {
    await setPolicySettings({ crossCampaignCooldownDays: 30 });
    const f = await fixture({ send: false });
    const other = await createDraftCampaign(db, {
      name: `Other cooldown ${sequence}`,
      type: "other",
      targetDescription: "Other relevant professional outreach",
      configuration: {},
      steps: [
        { delayMinutes: 0, subjectTemplate: "Other", bodyTemplate: "Other" },
      ],
    });
    if (!other.ok) throw new Error(other.message);
    await publishCampaignVersion(db, {
      campaignId: other.campaign.id,
      campaignVersionId: other.version.id,
    });
    const otherEnrollment = await enrollContact(db, {
      campaignId: other.campaign.id,
      campaignVersionId: other.version.id,
      contactId: f.contact.id,
      mailboxId: f.mailbox.id,
    });
    if (!otherEnrollment.ok) throw new Error(otherEnrollment.message);
    await db.insert(schema.messages).values({
      enrollmentId: otherEnrollment.enrollment.id,
      stepIndex: 0,
      direction: "outbound",
      outreachId: `cooldown_${sequence}`,
      subject: "History",
      body: "History",
      recipient: f.recipient,
      contactAccountId: f.contact.accountId,
      employmentVersion: f.contact.employmentVersion,
      status: "sent",
      sentAt: new Date(sentAt.getTime() - 86_400_000),
    });
    expect(
      await sendApprovedMessage(
        db,
        f.provider,
        { messageId: f.message.id },
        { clock: () => sentAt },
      ),
    ).toMatchObject({ ok: false, code: "RECENT_CONTACT_COOLDOWN" });

    await setPolicySettings();
    const irrelevant = await fixture({ send: false, relevant: false });
    expect(
      await sendApprovedMessage(
        db,
        irrelevant.provider,
        { messageId: irrelevant.message.id },
        { clock: () => sentAt },
      ),
    ).toMatchObject({ ok: false, code: "PROFESSIONAL_RELEVANCE_REQUIRED" });
  });

  it("blocks emergency pause through stored operator policy before provider send", async () => {
    await updateOperatorSendingSettings(db, {
      emergencyPause: true,
      timezone: "UTC",
      workingDays: [1, 2, 3, 4, 5],
      workingStartMinute: 0,
      workingEndMinute: 1_440,
      mailboxDailyCap: 25,
      campaignDailyCap: 100,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 0,
      crossCampaignCooldownDays: 0,
      actor: "operator",
    });
    sequence += 1;
    const n = sequence;
    const account = await createOrGetAccount(db, {
      name: `Paused ${n}`,
      domain: `paused-${n}.example`,
    });
    if (!account.ok) throw new Error(account.message);
    const contact = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: "E",
      lastName: `Stop${n}`,
      professionalRelevance: { relevant: true },
    });
    if (!contact.ok) throw new Error(contact.message);
    const campaign = await createDraftCampaign(db, {
      name: `Paused ${n}`,
      type: "other",
      targetDescription: "Relevant internal professional",
      configuration: {},
      steps: [{ delayMinutes: 0, subjectTemplate: "Hi", bodyTemplate: "Hi" }],
    });
    if (!campaign.ok) throw new Error(campaign.message);
    await publishCampaignVersion(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
    });
    const enrollment = await enrollContact(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
      contactId: contact.contact.id,
    });
    if (!enrollment.ok) throw new Error(enrollment.message);
    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: `stop-${n}@paused-${n}.example`,
    });
    if (!proposal.ok) throw new Error(proposal.message);
    await reviewMessage(db, {
      messageId: proposal.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    const provider = new MockMailProvider();
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: proposal.message.id },
        { clock: () => sentAt },
      ),
    ).toMatchObject({ ok: false, code: "EMERGENCY_PAUSED" });
    expect(provider.deliveries).toHaveLength(0);
    await updateOperatorSendingSettings(db, {
      emergencyPause: false,
      actor: "operator",
    });
  });
});
