import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import {
  pauseCampaign,
  stopEnrollment,
} from "@/modules/campaigns/lifecycle-service";
import { createOrGetContact } from "@/modules/contacts/service";
import type {
  MailProvider,
  MailReconciliation,
} from "@/modules/mailboxes/mail-provider";
import {
  DatabaseMockMailProvider,
  MockMailProvider,
} from "@/modules/mailboxes/mock-mail-provider";
import { updateMailboxStatus } from "@/modules/mailboxes/lifecycle-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { addSuppression } from "@/modules/suppression/service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 8 });
const lockProbeClient = postgres(testUrl, { max: 1 });
const db = drizzle(client, { schema });
let fixtureNumber = 0;

async function prepareApprovedMessage(options?: {
  mailbox?: boolean;
  review?: boolean;
}) {
  fixtureNumber += 1;
  const suffix = fixtureNumber;
  const account = await createOrGetAccount(db, {
    name: `Reliability ${suffix}`,
    domain: `reliability-${suffix}.example`,
  });
  if (!account.ok) throw new Error(account.message);
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Ada",
    lastName: `Lovelace${suffix}`,
    jobTitle: "CTO",
  });
  if (!contact.ok) throw new Error(contact.message);
  const campaign = await createDraftCampaign(db, {
    name: `Reliability campaign ${suffix}`,
    type: "commercial_outreach",
    targetDescription: "Technology executives at relevant businesses",
    configuration: {},
    steps: [
      {
        delayMinutes: 0,
        subjectTemplate: "Hello {{first_name}}",
        bodyTemplate: "A note for {{company}}",
      },
    ],
  });
  if (!campaign.ok) throw new Error(campaign.message);
  const published = await publishCampaignVersion(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
  });
  if (!published.ok) throw new Error(published.message);
  const mailbox = options?.mailbox
    ? (
        await db
          .insert(schema.mailboxConnections)
          .values({
            provider: "mock",
            email: `operator-${suffix}@example.com`,
            normalizedEmail: `operator-${suffix}@example.com`,
            status: "available",
          })
          .returning()
      )[0]
    : undefined;
  const enrollment = await enrollContact(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
    contactId: contact.contact.id,
    mailboxId: mailbox?.id,
  });
  if (!enrollment.ok) throw new Error(enrollment.message);
  const proposal = await generateOutreachProposal(db, {
    enrollmentId: enrollment.enrollment.id,
    stepIndex: 0,
    recipient: `ada-${suffix}@reliability-${suffix}.example`,
  });
  if (!proposal.ok) throw new Error(proposal.message);
  let message = proposal.message;
  if (options?.review !== false) {
    const reviewed = await reviewMessage(db, {
      messageId: proposal.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!reviewed.ok) throw new Error(reviewed.message);
    message = reviewed.message;
  }
  return {
    message,
    campaign: campaign.campaign,
    enrollment: enrollment.enrollment,
    mailbox,
  };
}

describe("reliable send attempt ownership and provider confirmation", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    await db.update(schema.operatorSendingSettings).set({
      timezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 1_440,
      mailboxDailyCap: 10_000,
      campaignDailyCap: 100_000,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 0,
      crossCampaignCooldownDays: 0,
    });
  });

  afterAll(async () => {
    await Promise.all([client.end(), lockProbeClient.end()]);
  });

  it("allows the credential-free mock provider without a mailbox", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider();
    expect(fixture.enrollment.mailboxId).toBeNull();
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.sendDraftCalls).toHaveLength(1);
  });

  it("recovers a persisted mock draft with a new provider after worker restart", async () => {
    const fixture = await prepareApprovedMessage();
    const draftId = `mock-draft-${fixture.message.outreachId}`;
    await db
      .update(schema.messages)
      .set({
        status: "sending",
        providerDraftId: draftId,
        sendAttemptToken: crypto.randomUUID(),
        sendClaimedAt: new Date(Date.now() - 60 * 60_000),
        attemptCount: 0,
      })
      .where(eq(schema.messages.id, fixture.message.id));

    await expect(
      sendApprovedMessage(
        db,
        new DatabaseMockMailProvider(db),
        { messageId: fixture.message.id },
        { claimStaleAfterMs: 1 },
      ),
    ).resolves.toMatchObject({ ok: false, code: "IN_PROGRESS" });
    await expect(
      sendApprovedMessage(db, new DatabaseMockMailProvider(db), {
        messageId: fixture.message.id,
      }),
    ).resolves.toMatchObject({ ok: true, disposition: "sent" });
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "sent",
      providerDraftId: draftId,
      providerMessageId: `mock-message-${fixture.message.outreachId}`,
    });
  });

  it("does not infer mock acceptance from a crash before provider invocation", async () => {
    const fixture = await prepareApprovedMessage();
    const draftId = `mock-draft-${fixture.message.outreachId}`;
    await db
      .update(schema.messages)
      .set({
        status: "sending",
        providerDraftId: draftId,
        sendAttemptToken: crypto.randomUUID(),
        sendClaimedAt: new Date(Date.now() - 60 * 60_000),
        sendAttemptedAt: new Date(Date.now() - 60 * 60_000),
        attemptCount: 1,
      })
      .where(eq(schema.messages.id, fixture.message.id));

    await expect(
      sendApprovedMessage(
        db,
        new DatabaseMockMailProvider(db),
        { messageId: fixture.message.id },
        { claimStaleAfterMs: 1 },
      ),
    ).resolves.toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      providerMessageId: null,
      sentAt: null,
    });
  });

  it("blocks a Graph send when a reply notification is durably staged", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    await db
      .update(schema.mailboxConnections)
      .set({ provider: "microsoft_graph" })
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    await db.insert(schema.graphNotificationReceipts).values({
      mailboxId: fixture.mailbox!.id,
      deduplicationKey: `staged-reply-${crypto.randomUUID()}`,
      subscriptionId: "subscription",
      resourceId: "reply-message",
      changeType: "created",
    });
    const mock = new MockMailProvider();
    const graphProvider: MailProvider = {
      kind: "microsoft_graph",
      createDraft: (input) => mock.createDraft(input),
      sendDraft: (input) => mock.sendDraft(input),
      reconcile: (input) => mock.reconcile(input),
    };
    await expect(
      sendApprovedMessage(db, graphProvider, {
        messageId: fixture.message.id,
      }),
    ).resolves.toMatchObject({ ok: false, code: "REPLY_PENDING" });
    expect(mock.sendDraftCalls).toHaveLength(0);
  });

  it("allows one concurrent worker to call sendDraft", async () => {
    const fixture = await prepareApprovedMessage();
    let releaseSend!: () => void;
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let firstSendStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    let secondSendEntered!: () => void;
    const secondEntered = new Promise<"entered">((resolve) => {
      secondSendEntered = () => resolve("entered");
    });

    class DelayedProvider extends MockMailProvider {
      private entries = 0;

      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        this.entries += 1;
        if (this.entries === 1) firstSendStarted();
        if (this.entries === 2) secondSendEntered();
        await sendRelease;
        return super.sendDraft(input);
      }
    }

    const provider = new DelayedProvider();
    const first = sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });
    await firstStarted;
    const second = sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });
    const concurrentObservation = await Promise.race([
      second.then(() => "returned" as const),
      secondEntered,
    ]);
    expect(concurrentObservation).toBe("returned");
    releaseSend();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ ok: true, disposition: "sent" });
    expect(secondResult).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(provider.sendDraftCalls).toHaveLength(1);
    expect(provider.deliveries).toHaveLength(1);

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({ status: "sent", attemptCount: 1 });
    const attempts = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    expect(
      attempts.filter((event) => event.event === "message.sending"),
    ).toHaveLength(1);
  });

  it("returns competing sends promptly while one global send is slow", async () => {
    const fixtures = await Promise.all(
      Array.from({ length: 6 }, () => prepareApprovedMessage()),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    class SlowProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        if (this.sendDraftCalls.length === 0) {
          started();
          await held;
        }
        return super.sendDraft(input);
      }
    }
    const provider = new SlowProvider();
    const first = sendApprovedMessage(db, provider, {
      messageId: fixtures[0]!.message.id,
    });
    await sendStarted;
    const competitors = fixtures
      .slice(1)
      .map((fixture) =>
        sendApprovedMessage(db, provider, { messageId: fixture.message.id }),
      );
    const prompt = await Promise.race([
      Promise.all(competitors),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 150),
      ),
    ]);
    expect(prompt).not.toBe("timeout");
    expect(prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: false, code: "IN_PROGRESS" }),
      ]),
    );
    release();
    expect(await first).toMatchObject({ ok: true, disposition: "sent" });
  });

  it("aborts a timed-out send attempt and leaves delivery uncertain", async () => {
    const fixture = await prepareApprovedMessage();
    class AbortableProvider extends MockMailProvider {
      aborted = false;
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0] & {
          signal?: AbortSignal;
        },
      ) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          input.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              this.aborted = true;
              reject(input.signal?.reason);
            },
            { once: true },
          );
        });
        return super.sendDraft(input);
      }
    }
    const provider = new AbortableProvider();
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: fixture.message.id },
        { providerOperationTimeoutMs: 25 },
      ),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.aborted).toBe(true);
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored?.status).toBe("delivery_uncertain");
  });

  it("releases every session lock after an injected unlock failure", async () => {
    await withActionLocks(
      db,
      [actionLockKey.settings(), actionLockKey.campaign(randomUUID())],
      async () => undefined,
      {
        async unlock() {
          throw new Error("injected unlock failure");
        },
      },
    );
    const [{ count }] = await lockProbeClient<[{ count: number }]>`
      select count(*)::int as count from pg_locks where locktype = 'advisory'
    `;
    expect(count).toBe(0);
    expect(await db.execute(sql`select 1 as healthy`)).toBeTruthy();
  });

  it("uses fresh final-policy and confirmation time", async () => {
    const fixture = await prepareApprovedMessage();
    await db.update(schema.operatorSendingSettings).set({
      timezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 60,
    });
    const times = [
      new Date("2026-08-12T00:59:00.000Z"),
      new Date("2026-08-12T01:00:00.000Z"),
    ];
    expect(
      await sendApprovedMessage(
        db,
        new MockMailProvider(),
        { messageId: fixture.message.id },
        { clock: () => times.shift() ?? new Date("2026-08-12T01:00:00.000Z") },
      ),
    ).toMatchObject({ ok: false, code: "OUTSIDE_WORKING_HOURS" });
    await db.update(schema.operatorSendingSettings).set({
      workingStartMinute: 0,
      workingEndMinute: 1_440,
    });

    const sentFixture = await prepareApprovedMessage();
    const sentTimes = [
      new Date("2026-08-12T10:00:00.000Z"),
      new Date("2026-08-12T10:01:00.000Z"),
      new Date("2026-08-12T10:02:00.000Z"),
    ];
    const sent = await sendApprovedMessage(
      db,
      new MockMailProvider(),
      { messageId: sentFixture.message.id },
      {
        clock: () => sentTimes.shift() ?? new Date("2026-08-12T10:02:00.000Z"),
      },
    );
    expect(sent).toMatchObject({ ok: true, disposition: "sent" });
    if (sent.ok)
      expect(sent.message.sentAt).toEqual(new Date("2026-08-12T10:02:00.000Z"));
  });

  it("blocks delivery when a terminal mutation owns the enrollment action lock before final policy", async () => {
    const fixture = await prepareApprovedMessage();
    let releaseMutation!: () => void;
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationOwnsLock!: () => void;
    const mutationOwned = new Promise<void>((resolve) => {
      mutationOwnsLock = resolve;
    });
    let mutation: Promise<void> | undefined;
    class MutationBeforeFinalPolicyProvider extends MockMailProvider {
      private started = false;

      override async reconcile(
        input: Parameters<MockMailProvider["reconcile"]>[0],
      ): Promise<MailReconciliation> {
        const result = await super.reconcile(input);
        if (!this.started && result?.status === "drafted") {
          this.started = true;
          mutation = withActionLocks(
            db,
            [actionLockKey.enrollment(fixture.enrollment.id)],
            async (lockedDb) => {
              await lockedDb.transaction(async (tx) => {
                await tx
                  .update(schema.enrollments)
                  .set({
                    state: "stopped",
                    stopReason: "manual_stop",
                    stoppedAt: new Date(),
                    nextActionAt: null,
                    nextActionToken: null,
                  })
                  .where(eq(schema.enrollments.id, fixture.enrollment.id));
              });
              mutationOwnsLock();
              await mutationRelease;
            },
          );
          await mutationOwned;
        }
        return result;
      }
    }
    const provider = new MutationBeforeFinalPolicyProvider();
    const sending = sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });
    await mutationOwned;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider.sendDraftCalls).toHaveLength(0);
    releaseMutation();
    await mutation;
    expect(await sending).toMatchObject({
      ok: false,
      code: "ENROLLMENT_INACTIVE",
    });
    expect(provider.deliveries).toHaveLength(0);
  });

  it("allows at most the current delivery when send owns action locks before a terminal reply", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let releaseSend!: () => void;
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendOwnsLocks!: () => void;
    const sendOwned = new Promise<void>((resolve) => {
      sendOwnsLocks = resolve;
    });
    class HeldSendProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        sendOwnsLocks();
        await sendRelease;
        return super.sendDraft(input);
      }
    }
    const provider = new HeldSendProvider();
    const sending = sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });
    await sendOwned;
    const replying = ingestInboundMessage(
      db,
      new DeterministicReplyClassifier(),
      {
        mailboxId: fixture.mailbox!.id,
        providerMessageId: `race-reply-${fixture.message.id}`,
        outreachId: fixture.message.outreachId!,
        sender: fixture.message.recipient,
        recipient: fixture.mailbox!.normalizedEmail,
        subject: "Interested",
        body: "Yes, interested",
        receivedAt: new Date(),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider.deliveries).toHaveLength(0);
    releaseSend();
    expect(await sending).toMatchObject({ ok: true, disposition: "sent" });
    expect(await replying).toMatchObject({
      ok: true,
      disposition: "processed",
    });
    expect(provider.deliveries).toHaveLength(1);
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, fixture.enrollment.id));
    expect(stored).toMatchObject({
      state: "completed",
      stopReason: "sequence_complete",
      nextActionAt: null,
    });
  });

  it("keeps accepted but unconfirmed mail uncertain and never re-sends it", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider({ confirmation: "manual" });

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.sendDraftCalls).toHaveLength(1);
    expect(provider.deliveries).toHaveLength(1);

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.sendDraftCalls).toHaveLength(1);

    const uncertainTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, fixture.message.id));
    expect(uncertainTransitions.map((row) => row.toState)).toEqual(
      expect.arrayContaining(["sending", "delivery_uncertain"]),
    );
    const uncertainEvents = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    expect(uncertainEvents.map((row) => row.event)).toEqual(
      expect.arrayContaining(["message.sending", "message.delivery_uncertain"]),
    );

    provider.confirm(fixture.message.outreachId!);
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.sendDraftCalls).toHaveLength(1);
  });

  it("records accepted reconciliation found before the local draft identity", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider({ confirmation: "manual" });
    const draft = await provider.createDraft({
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
      sender: null,
      recipient: fixture.message.recipient,
      subject: fixture.message.subject,
      body: fixture.message.body,
      headers: { "X-Outreach-ID": fixture.message.outreachId! },
    });
    await provider.sendDraft({
      draftId: draft.draftId,
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
    });

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.sendDraftCalls).toHaveLength(1);

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      providerDraftId: draft.draftId,
      attemptCount: 0,
      lastError: "Provider acceptance discovered during reconciliation",
    });
    const uncertainTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, fixture.message.id));
    expect(
      uncertainTransitions.filter(
        (row) => row.toState === "delivery_uncertain",
      ),
    ).toEqual([
      expect.objectContaining({
        fromState: "draft_creating",
        reason: "provider_acceptance_discovered_by_reconciliation",
      }),
    ]);
    const uncertainEvents = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    expect(
      uncertainEvents.filter(
        (row) => row.event === "message.delivery_uncertain",
      ),
    ).toEqual([
      expect.objectContaining({
        error: "Provider acceptance discovered during reconciliation",
      }),
    ]);
  });

  it("completes a one-step enrollment when delivery was confirmed before local recovery", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider({ confirmation: "manual" });
    const draft = await provider.createDraft({
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
      sender: null,
      recipient: fixture.message.recipient,
      subject: fixture.message.subject,
      body: fixture.message.body,
      headers: { "X-Outreach-ID": fixture.message.outreachId! },
    });
    await provider.sendDraft({
      draftId: draft.draftId,
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
    });
    provider.confirm(fixture.message.outreachId!);
    await db
      .update(schema.enrollments)
      .set({ state: "active" })
      .where(eq(schema.enrollments.id, fixture.enrollment.id));

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    const [stored] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, fixture.enrollment.id));
    expect(stored).toMatchObject({
      state: "completed",
      stopReason: "sequence_complete",
      nextActionAt: null,
    });
  });

  it.each([
    { providerOutcome: "throws" as const, claimAge: "fresh" as const },
    { providerOutcome: "throws" as const, claimAge: "stale" as const },
    { providerOutcome: "null" as const, claimAge: "fresh" as const },
    { providerOutcome: "null" as const, claimAge: "stale" as const },
    { providerOutcome: "drafted" as const, claimAge: "fresh" as const },
    { providerOutcome: "drafted" as const, claimAge: "stale" as const },
  ])(
    "keeps accepted-discovered delivery uncertainty absorbing when $providerOutcome reconciliation is $claimAge",
    async ({ providerOutcome, claimAge }) => {
      const fixture = await prepareApprovedMessage();
      const acceptedProvider = new MockMailProvider({ confirmation: "manual" });
      const draft = await acceptedProvider.createDraft({
        outreachId: fixture.message.outreachId!,
        mailboxId: null,
        sender: null,
        recipient: fixture.message.recipient,
        subject: fixture.message.subject,
        body: fixture.message.body,
        headers: fixture.message.headers,
      });
      await acceptedProvider.sendDraft({
        draftId: draft.draftId,
        outreachId: fixture.message.outreachId!,
        mailboxId: null,
      });
      expect(
        await sendApprovedMessage(db, acceptedProvider, {
          messageId: fixture.message.id,
        }),
      ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
      const sendCallsBeforeRecovery = acceptedProvider.sendDraftCalls.length;

      const controlledProvider: MailProvider = {
        kind: "mock",
        createDraft: (input) => acceptedProvider.createDraft(input),
        sendDraft: (input) => acceptedProvider.sendDraft(input),
        reconcile: async () => {
          if (providerOutcome === "throws") {
            throw new Error("credential=must-not-leak");
          }
          if (providerOutcome === "null") return null;
          return { status: "drafted", draftId: draft.draftId };
        },
      };
      const options =
        claimAge === "stale"
          ? {
              clock: () => new Date(Date.now() + 60 * 60_000),
              claimStaleAfterMs: 60_000,
            }
          : undefined;

      for (let invocation = 0; invocation < 2; invocation += 1) {
        expect(
          await sendApprovedMessage(
            db,
            controlledProvider,
            { messageId: fixture.message.id },
            options,
          ),
        ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
      }
      const [stored] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, fixture.message.id));
      expect(stored).toMatchObject({
        status: "delivery_uncertain",
        attemptCount: 0,
        providerDraftId: draft.draftId,
      });
      expect(acceptedProvider.sendDraftCalls).toHaveLength(
        sendCallsBeforeRecovery,
      );
    },
  );

  it("recovers a throw after provider acceptance by reconciliation without redelivery", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider({
      confirmation: "manual",
      throwAfterAccept: true,
    });

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.sendDraftCalls).toHaveLength(1);
    expect(provider.deliveries).toHaveLength(1);

    provider.confirm(fixture.message.outreachId!);
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.sendDraftCalls).toHaveLength(1);
    expect(provider.deliveries).toHaveLength(1);
  });

  it.each([
    { state: "replied" as const, stopReason: "positive_reply" as const },
    { state: "opted_out" as const, stopReason: "unsubscribe" as const },
    { state: "stopped" as const, stopReason: "manual_stop" as const },
  ])(
    "preserves enrollment $state and timestamps a late confirmation",
    async ({ state, stopReason }) => {
      const fixture = await prepareApprovedMessage();
      const provider = new MockMailProvider({ confirmation: "manual" });
      expect(
        await sendApprovedMessage(db, provider, {
          messageId: fixture.message.id,
        }),
      ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
      await db
        .update(schema.enrollments)
        .set({ state, stopReason, stoppedAt: new Date(), nextActionAt: null })
        .where(eq(schema.enrollments.id, fixture.enrollment.id));

      provider.confirm(fixture.message.outreachId!);
      expect(
        await sendApprovedMessage(db, provider, {
          messageId: fixture.message.id,
        }),
      ).toMatchObject({ ok: true, disposition: "sent" });
      const [storedEnrollment] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, fixture.enrollment.id));
      expect(storedEnrollment).toMatchObject({
        state,
        stopReason,
        nextActionAt: null,
      });
      expect(storedEnrollment?.lastMessageAt).toBeInstanceOf(Date);
    },
  );

  it("does not let a fresh non-owner provider failure release the owner's claim", async () => {
    const fixture = await prepareApprovedMessage();
    let releaseOwner!: () => void;
    const ownerRelease = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerReconcileStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      ownerReconcileStarted = resolve;
    });
    class DelayedOwnerProvider extends MockMailProvider {
      private reconciliationCount = 0;

      override async reconcile(
        input: Parameters<MockMailProvider["reconcile"]>[0],
      ): Promise<MailReconciliation> {
        this.reconciliationCount += 1;
        if (this.reconciliationCount === 1) {
          ownerReconcileStarted();
          await ownerRelease;
        } else if (this.reconciliationCount === 2) {
          throw new Error("token=non-owner-failure");
        }
        return super.reconcile(input);
      }
    }
    const provider = new DelayedOwnerProvider();
    const owner = sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });
    await ownerStarted;
    const [claimed] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(claimed?.sendAttemptToken).toBeTruthy();

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    const [afterNonOwner] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(afterNonOwner).toMatchObject({
      status: "draft_creating",
      sendAttemptToken: claimed!.sendAttemptToken,
      sendClaimedAt: claimed!.sendClaimedAt,
    });

    releaseOwner();
    expect(await owner).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.sendDraftCalls).toHaveLength(1);
  });

  it("releases a stale pre-attempt claim after authoritative draft reconciliation", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider();
    const draft = await provider.createDraft({
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
      sender: null,
      recipient: fixture.message.recipient,
      subject: fixture.message.subject,
      body: fixture.message.body,
      headers: fixture.message.headers,
    });
    const now = new Date("2026-08-11T12:00:00.000Z");
    await db
      .update(schema.messages)
      .set({
        providerDraftId: draft.draftId,
        status: "sending",
        sendAttemptToken: "stale-pre-attempt",
        sendClaimedAt: new Date("2026-08-11T11:00:00.000Z"),
        attemptCount: 0,
      })
      .where(eq(schema.messages.id, fixture.message.id));

    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: fixture.message.id },
        { clock: () => now, claimStaleAfterMs: 60_000 },
      ),
    ).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(provider.sendDraftCalls).toHaveLength(0);
    const [released] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(released).toMatchObject({
      status: "drafted",
      sendAttemptToken: null,
      sendClaimedAt: null,
      attemptCount: 0,
    });
    const releaseTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, fixture.message.id));
    expect(releaseTransitions).toContainEqual(
      expect.objectContaining({
        fromState: "sending",
        toState: "drafted",
        reason: "stale_claim_released_after_draft_reconciliation",
      }),
    );
    const releaseEvents = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    expect(releaseEvents.map((row) => row.event)).toContain(
      "message.stale_claim_released",
    );

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(provider.sendDraftCalls).toHaveLength(1);
  });

  it("makes a stale persisted send attempt visibly uncertain without re-sending", async () => {
    const fixture = await prepareApprovedMessage();
    const provider = new MockMailProvider();
    const draft = await provider.createDraft({
      outreachId: fixture.message.outreachId!,
      mailboxId: null,
      sender: null,
      recipient: fixture.message.recipient,
      subject: fixture.message.subject,
      body: fixture.message.body,
      headers: fixture.message.headers,
    });
    const now = new Date("2026-08-11T12:00:00.000Z");
    await db
      .update(schema.messages)
      .set({
        providerDraftId: draft.draftId,
        status: "sending",
        sendAttemptToken: "stale-attempted",
        sendClaimedAt: new Date("2026-08-11T11:00:00.000Z"),
        sendAttemptedAt: new Date("2026-08-11T11:00:01.000Z"),
        attemptCount: 1,
      })
      .where(eq(schema.messages.id, fixture.message.id));

    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: fixture.message.id },
        { clock: () => now, claimStaleAfterMs: 60_000 },
      ),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(provider.sendDraftCalls).toHaveLength(0);
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      lastError: "Stale persisted send attempt requires manual reconciliation",
    });
  });

  it("makes a stale claim with an unresolved provider outcome visibly uncertain", async () => {
    const fixture = await prepareApprovedMessage();
    const now = new Date("2026-08-11T12:00:00.000Z");
    await db
      .update(schema.messages)
      .set({
        status: "draft_creating",
        sendAttemptToken: "stale-unresolved",
        sendClaimedAt: new Date("2026-08-11T11:00:00.000Z"),
        attemptCount: 0,
      })
      .where(eq(schema.messages.id, fixture.message.id));
    class UnresolvedProvider extends MockMailProvider {
      override async reconcile(): Promise<MailReconciliation> {
        throw new Error("credential=top-secret unavailable");
      }
    }
    const provider = new UnresolvedProvider();

    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: fixture.message.id },
        { clock: () => now, claimStaleAfterMs: 60_000 },
      ),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      lastError: "Stale send claim requires manual reconciliation",
    });
    const events = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "message.provider_failed",
        "message.delivery_uncertain",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });

  it("performs provider I/O only after releasing database row locks", async () => {
    const fixture = await prepareApprovedMessage();
    async function assertMessageUnlocked(): Promise<void> {
      await lockProbeClient.begin(async (probe) => {
        await probe`
          select id from messages where id = ${fixture.message.id} for update nowait
        `;
      });
    }
    class LockCheckingProvider extends MockMailProvider {
      override async reconcile(
        input: Parameters<MockMailProvider["reconcile"]>[0],
      ): Promise<MailReconciliation> {
        await assertMessageUnlocked();
        return super.reconcile(input);
      }

      override async createDraft(
        input: Parameters<MockMailProvider["createDraft"]>[0],
      ) {
        await assertMessageUnlocked();
        return super.createDraft(input);
      }

      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        await assertMessageUnlocked();
        return super.sendDraft(input);
      }
    }
    const provider = new LockCheckingProvider();
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
  });

  it.each(["reconcile", "createDraft"] as const)(
    "returns a sanitized provider error when pre-send %s fails",
    async (operation) => {
      const fixture = await prepareApprovedMessage();
      class FailingProvider extends MockMailProvider {
        override async reconcile(
          input: Parameters<MockMailProvider["reconcile"]>[0],
        ): Promise<MailReconciliation> {
          if (operation === "reconcile") {
            throw new Error("token=top-secret reconciliation failure");
          }
          return super.reconcile(input);
        }

        override async createDraft(
          input: Parameters<MockMailProvider["createDraft"]>[0],
        ) {
          if (operation === "createDraft") {
            throw new Error("password=top-secret draft failure");
          }
          return super.createDraft(input);
        }
      }
      const provider = new FailingProvider();
      expect(
        await sendApprovedMessage(db, provider, {
          messageId: fixture.message.id,
        }),
      ).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
      const failures = await db
        .select()
        .from(schema.workflowEvents)
        .where(eq(schema.workflowEvents.entityId, fixture.message.id));
      const providerFailure = failures.find(
        (row) => row.event === "message.provider_failed",
      );
      expect(providerFailure?.error).toBe("Mail provider operation failed");
      expect(JSON.stringify(providerFailure)).not.toContain("top-secret");
    },
  );

  it("requires a mailbox for Microsoft Graph and rejects provider mismatch", async () => {
    function graphProvider(mock: MockMailProvider): MailProvider {
      return {
        kind: "microsoft_graph",
        createDraft: (input) => mock.createDraft(input),
        sendDraft: (input) => mock.sendDraft(input),
        reconcile: (input) => mock.reconcile(input),
      };
    }

    const noMailbox = await prepareApprovedMessage();
    const firstMock = new MockMailProvider();
    expect(
      await sendApprovedMessage(db, graphProvider(firstMock), {
        messageId: noMailbox.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });
    expect(firstMock.createDraftCalls).toHaveLength(0);

    const mockMailbox = await prepareApprovedMessage({ mailbox: true });
    const secondMock = new MockMailProvider();
    expect(
      await sendApprovedMessage(db, graphProvider(secondMock), {
        messageId: mockMailbox.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_PROVIDER_MISMATCH" });
    expect(secondMock.createDraftCalls).toHaveLength(0);
  });

  it.each([
    { state: "replied" as const, action: { kind: "approve" as const } },
    {
      state: "opted_out" as const,
      action: { kind: "reject" as const, reason: "stale review" },
    },
    { state: "stopped" as const, action: { kind: "approve" as const } },
  ])(
    "refuses stale $action.kind review for terminal enrollment $state",
    async ({ state, action }) => {
      const fixture = await prepareApprovedMessage({ review: false });
      await db
        .update(schema.enrollments)
        .set({ state })
        .where(eq(schema.enrollments.id, fixture.enrollment.id));
      expect(
        await reviewMessage(db, {
          messageId: fixture.message.id,
          action,
          actor: "operator",
        }),
      ).toMatchObject({ ok: false, code: "ENROLLMENT_TERMINAL" });
      const [storedMessage] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, fixture.message.id));
      expect(storedMessage?.status).toBe("proposed");
    },
  );

  it.each([
    {
      name: "suppression",
      expected: "RECIPIENT_SUPPRESSED",
      mailbox: false,
      mutate: async (
        fixture: Awaited<ReturnType<typeof prepareApprovedMessage>>,
      ) => {
        await addSuppression(db, {
          scope: "email",
          value: fixture.message.recipient,
          reason: "unsubscribe",
          actor: "operator",
        });
      },
    },
    {
      name: "campaign pause",
      expected: "CAMPAIGN_INACTIVE",
      mailbox: false,
      mutate: async (
        fixture: Awaited<ReturnType<typeof prepareApprovedMessage>>,
      ) => {
        await pauseCampaign(db, {
          campaignId: fixture.campaign.id,
          actor: "operator",
        });
      },
    },
    {
      name: "enrollment stop",
      expected: "ENROLLMENT_INACTIVE",
      mailbox: false,
      mutate: async (
        fixture: Awaited<ReturnType<typeof prepareApprovedMessage>>,
      ) => {
        await stopEnrollment(db, {
          enrollmentId: fixture.enrollment.id,
          actor: "operator",
        });
      },
    },
    {
      name: "mailbox disconnect",
      expected: "MAILBOX_UNAVAILABLE",
      mailbox: true,
      mutate: async (
        fixture: Awaited<ReturnType<typeof prepareApprovedMessage>>,
      ) => {
        await updateMailboxStatus(db, {
          mailboxId: fixture.mailbox!.id,
          status: "disconnected",
          actor: "operator",
        });
      },
    },
  ])(
    "runs the final $name policy after provider reconciliation",
    async ({ expected, mailbox, mutate }) => {
      const fixture = await prepareApprovedMessage({ mailbox });
      class MutatingReconciliationProvider extends MockMailProvider {
        private mutated = false;

        override async reconcile(
          input: Parameters<MockMailProvider["reconcile"]>[0],
        ): Promise<MailReconciliation> {
          const result = await super.reconcile(input);
          if (!this.mutated && result?.status === "drafted") {
            this.mutated = true;
            await mutate(fixture);
          }
          return result;
        }
      }
      const provider = new MutatingReconciliationProvider();

      expect(
        await sendApprovedMessage(db, provider, {
          messageId: fixture.message.id,
        }),
      ).toMatchObject({ ok: false, code: expected });
      expect(provider.sendDraftCalls).toHaveLength(0);
      expect(provider.deliveries).toHaveLength(0);
      const [stored] = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, fixture.message.id));
      expect(stored).toMatchObject({ status: "drafted", attemptCount: 0 });
    },
  );
});
