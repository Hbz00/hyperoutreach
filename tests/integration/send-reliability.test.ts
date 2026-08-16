import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { ImapAuthenticationError } from "@/lib/smtp-imap/imap-client";
import {
  decryptSecret,
  encryptSecret,
  type EncryptionKeyring,
} from "@/lib/microsoft/token-crypto";
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
import {
  defaultInboundNaming,
  withInboundReconciliationHealth,
} from "@/modules/mailboxes/inbound-reconciliation";
import { updateMailboxStatus } from "@/modules/mailboxes/lifecycle-service";
import {
  connectSmtpImapMailbox,
  disconnectSmtpImapMailbox,
} from "@/modules/mailboxes/smtp-imap-connection-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { addSuppression } from "@/modules/suppression/service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

// Its own disposable keyring, distinct from whatever `.env.local`/`process.env`
// sets -- threaded explicitly via `connectSmtpImapMailbox`'s `environment`
// dep below so the revival test never depends on (or clobbers) real process
// env state, matching `smtp-imap-provider-bootstrap.test.ts`'s own pattern.
const connectionKeyring: EncryptionKeyring = {
  activeKeyId: "connection-v1",
  keys: { "connection-v1": randomBytes(32) },
};
const connectionEnvironment = {
  TOKEN_ENCRYPTION_ACTIVE_KEY_ID: connectionKeyring.activeKeyId,
  TOKEN_ENCRYPTION_KEYS: `connection-v1:${connectionKeyring.keys["connection-v1"]!.toString("base64")}`,
};

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 8 });
const lockProbeClient = postgres(testUrl, { max: 1 });
const db = drizzle(client, { schema });
let fixtureNumber = 0;

async function prepareApprovedMessage(options?: {
  mailbox?: boolean;
  /** Enroll against an existing mailbox row instead of creating a new one
   * (or none) — for tests that need a second, independent message sharing
   * the same mailbox, e.g. to prove a mailbox-level status change blocks a
   * *different* message on that mailbox. Takes precedence over `mailbox`. */
  reuseMailboxId?: string;
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
  const mailbox =
    !options?.reuseMailboxId && options?.mailbox
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
    mailboxId: options?.reuseMailboxId ?? mailbox?.id,
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

  it("turns a definite recipient 5xx into failed+bounced suppression, never delivery uncertainty", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    await db
      .update(schema.mailboxConnections)
      .set({ provider: "smtp_imap" })
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    const mock = new MockMailProvider();
    let rejected = false;
    const provider: MailProvider = {
      kind: "smtp_imap",
      createDraft: (input) => mock.createDraft(input),
      sendDraft: async () => {
        rejected = true;
        throw new Error("550 5.1.1 No such user");
      },
      reconcile: async (input) =>
        rejected
          ? {
              status: "rejected",
              draftId: input.draftId!,
              responseCode: 550,
              response: "550 5.1.1 No such user",
              smtpErrorCode: "EENVELOPE",
              hardBounce: true,
            }
          : mock.reconcile(input),
    };
    await expect(
      sendApprovedMessage(db, provider, { messageId: fixture.message.id }),
    ).resolves.toMatchObject({ ok: false, code: "PERMANENT_REJECTION" });
    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    const [storedEnrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, fixture.enrollment.id));
    const [suppression] = await db
      .select()
      .from(schema.suppressionEntries)
      .where(
        eq(
          schema.suppressionEntries.normalizedValue,
          fixture.message.recipient,
        ),
      );
    expect(storedMessage).toMatchObject({ status: "failed" });
    expect(storedEnrollment).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
    });
    expect(suppression).toMatchObject({ reason: "hard_bounce" });
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

  it("blocks a Graph send when graph_delta_health is failing (literal survives the generic dispatcher)", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    await db
      .update(schema.mailboxConnections)
      .set({ provider: "microsoft_graph" })
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    await db.insert(schema.workflowEvents).values({
      entityType: "mailbox",
      entityId: fixture.mailbox!.id,
      event: "graph.delta_failed",
      workflowName: "graph_delta_health",
      idempotencyKey: `graph:delta-health:${fixture.mailbox!.id}`,
      status: "failed",
      startedAt: new Date(),
      completedAt: new Date(),
      error: "Microsoft Graph delta reconciliation failed",
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

  it("blocks an smtp_imap send when inbound reconciliation is failing", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    await db
      .update(schema.mailboxConnections)
      .set({ provider: "smtp_imap" })
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    // Built from `defaultInboundNaming`, exactly like the round itself
    // (`inbound-source-bootstrap.ts`) — a hand-typed `workflowName` here
    // would keep passing even if the producer and the gate drifted apart,
    // which is the one drift that silently disarms this guard.
    const naming = defaultInboundNaming("smtp_imap", fixture.mailbox!.id);
    expect(naming.workflowName).toBe("inbound_reconciliation");
    await db.insert(schema.workflowEvents).values({
      entityType: "mailbox",
      entityId: fixture.mailbox!.id,
      event: naming.event,
      workflowName: naming.workflowName,
      idempotencyKey: naming.healthKey,
      status: "failed",
      startedAt: new Date(),
      completedAt: new Date(),
      error: naming.failureError,
    });
    const mock = new MockMailProvider();
    const imapProvider: MailProvider = {
      kind: "smtp_imap",
      createDraft: (input) => mock.createDraft(input),
      sendDraft: (input) => mock.sendDraft(input),
      reconcile: (input) => mock.reconcile(input),
    };
    await expect(
      sendApprovedMessage(db, imapProvider, {
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
    // Scoped to this test's own key. Counting every advisory lock in the
    // cluster was not a stronger assertion, only a flakier one: test files run
    // in parallel against one database and every send takes action locks, so
    // the count reported other files' work. Acquiring the key from a separate
    // connection is the direct question — is it free? — and the individual
    // unlock is injected to throw, so it can only be free if the blanket
    // `pg_advisory_unlock_all` release ran.
    const releasedKey = actionLockKey.campaign(randomUUID());
    await withActionLocks(
      db,
      [actionLockKey.settings(), releasedKey],
      async () => undefined,
      {
        async unlock() {
          throw new Error("injected unlock failure");
        },
      },
    );
    const [{ acquired }] = await lockProbeClient<[{ acquired: boolean }]>`
      select pg_try_advisory_lock(hashtextextended(${releasedKey}, 0)) as acquired
    `;
    expect(acquired).toBe(true);
    await lockProbeClient`
      select pg_advisory_unlock(hashtextextended(${releasedKey}, 0))
    `;
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

  // `"drafted"` is deliberately absent from this matrix: unlike `"throws"`
  // and `"null"` (nothing usable to act on either way), a fresh `"drafted"`
  // reconciliation is *positive proof* nothing was sent, and — as of this
  // fix — is the one outcome that releases the claim instead of re-marking
  // it uncertain forever. See the two dedicated tests immediately below
  // this block for that behavior, and the task's report for why leaving it
  // out of this matrix is intentional, not an oversight.
  it.each([
    { providerOutcome: "throws" as const, claimAge: "fresh" as const },
    { providerOutcome: "throws" as const, claimAge: "stale" as const },
    { providerOutcome: "null" as const, claimAge: "fresh" as const },
    { providerOutcome: "null" as const, claimAge: "stale" as const },
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
          return null;
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

  it("resends after delivery-uncertain once a fresh reconciliation proves nothing was actually sent", async () => {
    // Models the real motivating scenario end to end: `smtp_imap` throws on
    // a 4xx (a released journal attempt, per this task's fix in the
    // provider layer) rather than the "provider accepted it outside of
    // send-service's own bookkeeping" shortcut the sibling tests above use
    // — so this message reaches delivery_uncertain with a *real*
    // `attemptCount`, exactly like a genuine greylisted first send would.
    const fixture = await prepareApprovedMessage();
    let sendAttempts = 0;
    let confirmed = false;
    const controlledDraftId = "controlled-draft-1";
    const provider: MailProvider = {
      kind: "mock",
      createDraft: async () => ({ draftId: controlledDraftId }),
      sendDraft: async () => {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("451 4.7.1 Greylisted, try again later");
        }
        confirmed = true;
        return { status: "accepted" };
      },
      reconcile: async () => {
        if (confirmed) {
          return {
            status: "sent",
            draftId: controlledDraftId,
            providerMessageId: "provider-message-1",
            internetMessageId: null,
            conversationId: null,
          };
        }
        // Never accepted -- the throw above happened before anything was
        // ever marked accepted, so the draft is still just sitting there.
        return { status: "drafted", draftId: controlledDraftId };
      },
    };

    // First call: the real attempt transaction runs, `sendDraft` throws,
    // and delivery-uncertain is reached with `attemptCount: 1`.
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);
    const [afterFirstAttempt] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(afterFirstAttempt).toMatchObject({
      status: "delivery_uncertain",
      attemptCount: 1,
    });

    // Second call: lands in `existing_claim`. Fresh reconciliation still
    // says "drafted" -- positive proof nothing was sent -- so the claim is
    // released instead of being re-marked uncertain again.
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "IN_PROGRESS" });
    expect(sendAttempts).toBe(1); // no resend on the release pass itself
    const [released] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(released).toMatchObject({
      status: "drafted",
      attemptCount: 0,
      sendAttemptToken: null,
      providerDraftId: controlledDraftId,
    });

    // Third call: no longer trapped -- a fresh claim reaches `sendDraft`
    // again, and this time it actually succeeds.
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(sendAttempts).toBe(2);
  });

  it("leaves a delivery-uncertain message untouched when reconciliation finds nothing at all", async () => {
    // The paired negative case, same fixture shape as the test above:
    // `null` is an absence of proof, not proof of absence -- it must never
    // release the claim.
    const fixture = await prepareApprovedMessage();
    let sendAttempts = 0;
    const controlledDraftId = "controlled-draft-2";
    const provider: MailProvider = {
      kind: "mock",
      createDraft: async () => ({ draftId: controlledDraftId }),
      sendDraft: async () => {
        sendAttempts += 1;
        throw new Error("451 4.7.1 Greylisted, try again later");
      },
      reconcile: async () => null,
    };

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      attemptCount: 1,
      providerDraftId: controlledDraftId,
    });
  });

  // Task 10 bis, fix round 2: design doc §8 -- "les échecs d'authentification
  // passent la boîte en `unavailable`... ils ne sont pas réessayés en
  // boucle." Without this, an SMTP `EAUTH` composes with the release above
  // into an unbounded loop: attempt -> delivery_uncertain -> released
  // (reconcile still says "drafted", nothing about *this message* was the
  // problem) -> attempt again -- one full SMTP login per recovery tick,
  // forever, which is exactly the pattern that trips provider-side account
  // lockouts (a real risk for the school Zimbra mailbox this whole feature
  // targets, on a mistyped password). The fix must stop the *next* claim
  // before it ever reaches the provider at all.
  it("marks the mailbox revoked on an SMTP authentication failure, blocking a later send before any provider call", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let sendAttempts = 0;
    let createDraftCalls = 0;
    const authFailingProvider: MailProvider = {
      kind: "mock",
      createDraft: async () => {
        createDraftCalls += 1;
        return { draftId: "controlled-draft-auth" };
      },
      sendDraft: async () => {
        sendAttempts += 1;
        const authError = new Error("Invalid login") as Error & {
          smtpErrorCode?: string;
          responseCode?: number;
        };
        authError.smtpErrorCode = "EAUTH";
        authError.responseCode = 535;
        throw authError;
      },
      reconcile: async () => ({
        status: "drafted",
        draftId: "controlled-draft-auth",
      }),
    };

    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    const [mailboxAfterFailure] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    expect(mailboxAfterFailure).toMatchObject({ status: "revoked" });

    const mailboxTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, fixture.mailbox!.id),
        ),
      );
    expect(mailboxTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "available",
          toState: "revoked",
          reason: "smtp_authentication_failed",
          actor: "system",
        }),
      ]),
    );

    // A later send for a *different* message on the same, now-revoked
    // mailbox is blocked by send-policy before the provider is consulted at
    // all -- no `createDraft`, no `sendDraft`, i.e. no SMTP connection.
    const second = await prepareApprovedMessage({
      reuseMailboxId: fixture.mailbox!.id,
    });
    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: second.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });
    expect(sendAttempts).toBe(1);
    expect(createDraftCalls).toBe(0);
  });

  // Task 12: the classification above was too broad. `nodemailer` sets
  // `code: 'EAUTH'` for *any* non-2xx AUTH response, including a transient
  // one -- a `454 4.7.0 Temporary authentication failure` (Postfix, when its
  // SASL backend is momentarily unreachable) is `EAUTH` too, but is not a
  // verdict on the stored password. Revoking on this would quarantine a
  // mailbox for a problem that clears itself on the next tick. This proves
  // the mailbox stays `available` -- and, unlike the 535 case above, a later
  // send on the same mailbox is not blocked by mailbox status at all.
  it("does not revoke the mailbox on a transient SMTP authentication failure (454, temporary SASL backend unavailable)", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let sendAttempts = 0;
    const transientAuthProvider: MailProvider = {
      kind: "mock",
      createDraft: async () => ({ draftId: "controlled-draft-transient-auth" }),
      sendDraft: async () => {
        sendAttempts += 1;
        const authError = new Error(
          "Temporary authentication failure",
        ) as Error & {
          smtpErrorCode?: string;
          responseCode?: number;
        };
        authError.smtpErrorCode = "EAUTH";
        authError.responseCode = 454;
        throw authError;
      },
      reconcile: async () => ({
        status: "drafted",
        draftId: "controlled-draft-transient-auth",
      }),
    };

    expect(
      await sendApprovedMessage(db, transientAuthProvider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    const [mailboxAfterFailure] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    expect(mailboxAfterFailure).toMatchObject({ status: "available" });

    const mailboxTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, fixture.mailbox!.id),
        ),
      );
    expect(mailboxTransitions).toEqual([]);
  });

  // Task 10 bis, fix round 3: fix round 2 closed the loop for a *fresh*
  // claim (blocked by send-policy before the provider), but a message that
  // was already `delivery_uncertain`/mid-attempt at the moment the mailbox
  // got revoked keeps routing through `existing_claim` on every recovery
  // tick -- and that branch called `reconcileProvider` unconditionally,
  // never checking mailbox availability first. For `smtp_imap` that means
  // one real IMAP login (with the same bad password) per tick, forever --
  // the exact same lockout risk this whole task exists to close, just
  // walking in through the other protocol. This proves the provider is
  // never touched at all once the mailbox is revoked, regardless of what
  // state the message itself is already in.
  it("never calls the provider on the existing_claim path once the mailbox is revoked", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let reconcileCalls = 0;
    let sendAttempts = 0;
    const provider: MailProvider = {
      kind: "mock",
      createDraft: async () => ({ draftId: "controlled-draft-blocked" }),
      sendDraft: async () => {
        sendAttempts += 1;
        return { status: "accepted" };
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { status: "drafted", draftId: "controlled-draft-blocked" };
      },
    };
    // Seed the message directly into the exact shape a real "attempt threw,
    // still delivery_uncertain" message would have -- mirrors the seeding
    // style already used by "releases a stale pre-attempt claim..." above,
    // rather than driving a full attempt cycle through this same provider.
    await db
      .update(schema.messages)
      .set({
        status: "delivery_uncertain",
        providerDraftId: "controlled-draft-blocked",
        sendAttemptToken: randomUUID(),
        sendClaimedAt: new Date(),
        attemptCount: 1,
      })
      .where(eq(schema.messages.id, fixture.message.id));
    expect(
      await updateMailboxStatus(db, {
        mailboxId: fixture.mailbox!.id,
        status: "revoked",
        actor: "operator",
      }),
    ).toMatchObject({ ok: true });

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });

    expect(reconcileCalls).toBe(0);
    expect(sendAttempts).toBe(0);
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    // Untouched -- still exactly the delivery_uncertain row seeded above,
    // reclaimable the instant the mailbox is reconnected.
    expect(stored).toMatchObject({
      status: "delivery_uncertain",
      attemptCount: 1,
      providerDraftId: "controlled-draft-blocked",
    });
  });

  // Task 10 bis, fix round 3, second point: "un mot de passe erroné se
  // manifestera en réalité d'abord côté IMAP -- c'est le premier protocole
  // contacté". `fetchDraftSource` (an IMAP round trip) runs inside
  // `sendDraft`, before SMTP is ever touched, so this exercises the exact
  // same catch block as the SMTP EAUTH test (round 2) but with the IMAP
  // failure shape instead.
  it("marks the mailbox revoked on an IMAP authentication failure, blocking a later send before any provider call", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let sendAttempts = 0;
    let createDraftCalls = 0;
    const authFailingProvider: MailProvider = {
      kind: "mock",
      createDraft: async () => {
        createDraftCalls += 1;
        return { draftId: "controlled-draft-imap-auth" };
      },
      sendDraft: async () => {
        sendAttempts += 1;
        throw new ImapAuthenticationError("Login failed");
      },
      reconcile: async () => ({
        status: "drafted",
        draftId: "controlled-draft-imap-auth",
      }),
    };

    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    const [mailboxAfterFailure] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    expect(mailboxAfterFailure).toMatchObject({ status: "revoked" });

    const mailboxTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, fixture.mailbox!.id),
        ),
      );
    expect(mailboxTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "available",
          toState: "revoked",
          reason: "imap_authentication_failed",
          actor: "system",
        }),
      ]),
    );

    const second = await prepareApprovedMessage({
      reuseMailboxId: fixture.mailbox!.id,
    });
    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: second.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });
    expect(sendAttempts).toBe(1);
    expect(createDraftCalls).toBe(0);
  });

  it("does not revoke the mailbox on an ambiguous IMAP network failure", async () => {
    // The paired negative case: a dropped connection carries no verdict on
    // the credentials at all -- revoking here would be exactly the
    // "en cas de doute, ne révoque pas" mistake this classifier exists to
    // avoid.
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let sendAttempts = 0;
    // Draft id derived per outreach, not a fixed literal: two distinct
    // messages sharing the same mailbox would otherwise collide on the
    // `(mailboxId, providerDraftId)` unique index.
    const networkFailingProvider: MailProvider = {
      kind: "mock",
      createDraft: async (input) => ({
        draftId: `controlled-draft-${input.outreachId}`,
      }),
      sendDraft: async () => {
        sendAttempts += 1;
        const networkError = new Error("socket hang up") as Error & {
          code?: string;
        };
        networkError.code = "ECONNRESET";
        throw networkError;
      },
      reconcile: async (input) => ({
        status: "drafted",
        draftId: `controlled-draft-${input.outreachId}`,
      }),
    };

    expect(
      await sendApprovedMessage(db, networkFailingProvider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(1);

    const [mailboxAfterFailure] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    expect(mailboxAfterFailure).toMatchObject({ status: "available" });

    const mailboxTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, fixture.mailbox!.id),
        ),
      );
    expect(mailboxTransitions).toHaveLength(0);

    // And, unlike the revoked case, a later send on the same mailbox is
    // still allowed to reach the provider.
    const second = await prepareApprovedMessage({
      reuseMailboxId: fixture.mailbox!.id,
    });
    expect(
      await sendApprovedMessage(db, networkFailingProvider, {
        messageId: second.message.id,
      }),
    ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(sendAttempts).toBe(2);
  });

  it("marks the mailbox revoked on an IMAP authentication failure surfaced by createDraft, before any sendDraft is ever attempted", async () => {
    // The scenario the coordinator named explicitly: a bad password
    // surfaces on IMAP *first*, and for a message that has never been
    // drafted yet, that means `createDraft`'s `appendDraft` call fails
    // before `sendDraft` is ever reached. This exercises the
    // `recordProviderFailure({ error, mailboxId })` call site in the
    // `draft_creating` branch's `createDraft` catch (send-service.ts), a
    // different call site than the `sendDraft`-catch one already covered
    // above — and, until this test, the only `recordProviderFailure`
    // call site that has ever revoked a mailbox with no test proving it.
    const fixture = await prepareApprovedMessage({ mailbox: true });
    let createDraftCalls = 0;
    let sendAttempts = 0;
    const authFailingProvider: MailProvider = {
      kind: "mock",
      createDraft: async () => {
        createDraftCalls += 1;
        throw new ImapAuthenticationError("Login failed");
      },
      sendDraft: async () => {
        sendAttempts += 1;
        return { status: "accepted" };
      },
      reconcile: async () => null,
    };

    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
    expect(createDraftCalls).toBe(1);
    expect(sendAttempts).toBe(0);

    const [mailboxAfterFailure] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, fixture.mailbox!.id));
    expect(mailboxAfterFailure).toMatchObject({ status: "revoked" });

    const mailboxTransitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, fixture.mailbox!.id),
        ),
      );
    expect(mailboxTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "available",
          toState: "revoked",
          reason: "imap_authentication_failed",
          actor: "system",
        }),
      ]),
    );

    const second = await prepareApprovedMessage({
      reuseMailboxId: fixture.mailbox!.id,
    });
    expect(
      await sendApprovedMessage(db, authFailingProvider, {
        messageId: second.message.id,
      }),
    ).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });
    expect(createDraftCalls).toBe(1);
    expect(sendAttempts).toBe(0);
  });

  // Task 12: the sync anchor requirement. Task 11's inbound source bounds its
  // very first IMAP walk by `lastSyncedAt` (`inbound-source-bootstrap.ts`:
  // "a mailbox with neither an anchor nor a cursor hasn't finished
  // connecting yet" -- throws otherwise, the reconcile round reports
  // `failed`, and the send gate never opens). This is the INSERT path (a
  // mailbox row that never existed before): pins the exact value, not just
  // "is a Date", via the `now` seam `connectSmtpImapMailboxDeps` exposes for
  // this reason.
  it("anchors lastSyncedAt to exactly now-minus-5-minutes on a brand-new smtp_imap connection", async () => {
    const suffix = randomUUID();
    const email = `fresh-${suffix}@example.com`;
    const fixedNow = new Date("2026-01-15T12:00:00.000Z");
    const discoveredFolders = {
      drafts: "Drafts",
      sent: "Sent",
      inbox: "INBOX",
    };

    const result = await connectSmtpImapMailbox(
      db,
      {
        email,
        password: "first-connect-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        now: fixedNow,
        imapVerify: async () => discoveredFolders,
        smtpVerify: async () => {},
      },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected the fresh connect to succeed");

    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, result.mailbox.id));
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("available");
    expect(stored!.settings).toMatchObject({
      transport: { folders: discoveredFolders },
    });
    // No prior row, so no prior cursor -- a brand-new mailbox's correct
    // first state, exactly as the write path's own doc comment states.
    expect(stored!.syncCursor).toBeNull();
    // Pinned exactly, not merely "is a Date": five minutes before the
    // injected clock, matching `microsoft-oauth-service.ts:281`'s own
    // anchor expression for the same guard.
    expect(stored!.lastSyncedAt?.getTime()).toBe(
      fixedNow.getTime() - 5 * 60_000,
    );

    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, result.mailbox.id),
        ),
      );
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: null,
          toState: "available",
          reason: "smtp_imap_connected",
          actor: "operator",
        }),
      ]),
    );
  });

  // I1 : la garde d'envoi ne s'armait jamais sur une boîte qui n'a jamais
  // synchronisé. `send-service.ts`'s `inboundSyncPending` needs a
  // `workflowEvents` row that is *not* `succeeded`; nothing schedules an
  // `smtp_imap` inbound round (no cron — an assumed non-goal of the design),
  // so a mailbox connected five seconds ago had **no row at all**, the gate
  // read "clear", and the next sequence step went out having never read one
  // single reply. The prospect may have already answered "stop writing to
  // me". This pins both halves: armed at connect, disarmed by the first
  // successful round and by nothing else.
  it("blocks the first send on a freshly connected smtp_imap mailbox until an inbound round has actually succeeded", async () => {
    const suffix = randomUUID();
    const email = `never-synced-${suffix}@example.com`;
    const connected = await connectSmtpImapMailbox(
      db,
      {
        email,
        password: "first-connect-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        imapVerify: async () => ({
          drafts: "Drafts",
          sent: "Sent",
          inbox: "INBOX",
        }),
        smtpVerify: async () => {},
      },
    );
    expect(connected).toMatchObject({ ok: true });
    if (!connected.ok) throw new Error("expected the fresh connect to succeed");

    // The armed health record, under the *same* idempotency key the round's
    // own health wrapper uses — that shared key is the whole mechanism, so
    // it is read here through `defaultInboundNaming`, never a literal.
    const naming = defaultInboundNaming("smtp_imap", connected.mailbox.id);
    const [armed] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.idempotencyKey, naming.healthKey));
    expect(armed).toBeDefined();
    expect(armed!.status).not.toBe("succeeded");
    expect(armed!.workflowName).toBe(naming.workflowName);
    expect(armed!.entityId).toBe(connected.mailbox.id);

    // A provider bound exactly the way `provider-bootstrap.ts` binds one,
    // so the send fails on the inbound gate and not on the provider-binding
    // check that precedes it.
    let draftCalls = 0;
    let drafted: string | null = null;
    const provider: MailProvider = {
      kind: "smtp_imap",
      createDraft: async () => {
        draftCalls += 1;
        drafted = `gate-draft-${suffix}`;
        return { draftId: drafted };
      },
      sendDraft: async () => ({ status: "accepted" }),
      // `null` until a draft actually exists, so the pre-send reconciliation
      // reports "nothing there" and the send has to go through `createDraft`
      // — otherwise a stub that always answers "sent" would finalize the
      // message without ever proving the gate reopened for a real send.
      reconcile: async () =>
        drafted
          ? {
              status: "sent",
              draftId: drafted,
              providerMessageId: `gate-message-${suffix}`,
              internetMessageId: `<gate-${suffix}@example.com>`,
              conversationId: null,
            }
          : null,
    };

    const blocked = await prepareApprovedMessage({
      reuseMailboxId: connected.mailbox.id,
    });
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: blocked.message.id,
      }),
    ).toMatchObject({ ok: false, code: "REPLY_PENDING" });
    // Blocked *before* the provider was ever asked to draft anything.
    expect(draftCalls).toBe(0);

    // The operator's first successful "Sync now", through the real health
    // wrapper — the same function the reconcile task wraps every round in.
    // If the connect-time seed used a different event/key, this would leave
    // the seeded row untouched and the mailbox blocked forever.
    await withInboundReconciliationHealth(
      db,
      connected.mailbox.id,
      naming,
      async () => undefined,
    );
    const [disarmed] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.idempotencyKey, naming.healthKey));
    expect(disarmed!.status).toBe("succeeded");
    // Exactly one health row for this mailbox: the round updated the seeded
    // row rather than inserting a second one next to it.
    const healthRows = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        and(
          eq(schema.workflowEvents.entityId, connected.mailbox.id),
          eq(schema.workflowEvents.workflowName, naming.workflowName),
        ),
      );
    expect(healthRows).toHaveLength(1);

    expect(
      await sendApprovedMessage(db, provider, {
        messageId: blocked.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    expect(draftCalls).toBe(1);
  });

  // Task 12: the load-bearing requirement this task exists to close. Task 10
  // bis's auto-revocation (the two tests above and their SMTP counterparts)
  // stops a bad-credential mailbox from looping -- but nothing wrote
  // `status: "available"` for an `smtp_imap` mailbox anywhere else in the
  // codebase (`updateMailboxStatus` has no caller outside tests), so a
  // mailbox revoked by a typo would otherwise stay dead forever: the unique
  // index on `(provider, normalized_email)` refuses a second row for the
  // same address. `connectSmtpImapMailbox` is that path. This proves both
  // halves the brief demands: the row itself flips back to `available`
  // (with a fresh ciphertext, the discovered folders, and an honest
  // transition row), *and* the mailbox is concretely usable for a real send
  // afterwards -- not just a status flag no other code path consults.
  it("revives a revoked smtp_imap mailbox on reconnection with valid credentials, and it sends again", async () => {
    const suffix = randomUUID();
    const email = `revived-${suffix}@example.com`;
    const staleTransport = {
      transport: {
        username: "old-username",
        imap: { host: "old-imap.example.com", port: 993, security: "tls" },
        smtp: { host: "old-smtp.example.com", port: 587, security: "starttls" },
        folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
      },
    };
    // A mailbox that reached `revoked` already completed at least one
    // inbound round before that (it has a `syncCursor`), so it also already
    // carries a `lastSyncedAt` from that history -- fix round 1 preserves
    // this value on reconnection rather than resetting it, matching
    // `microsoft-oauth-service.ts:280-281`'s own precedent.
    const preRevocationLastSyncedAt = new Date("2026-01-01T00:00:00.000Z");
    const [revoked] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "smtp_imap",
        email,
        normalizedEmail: email,
        status: "revoked",
        encryptedPassword: encryptSecret(
          "stale-wrong-password",
          connectionKeyring,
        ),
        settings: staleTransport,
        syncCursor: "77:120",
        lastSyncedAt: preRevocationLastSyncedAt,
      })
      .returning();
    if (!revoked) throw new Error("fixture mailbox missing");
    await db.insert(schema.stateTransitions).values({
      entityType: "mailbox",
      entityId: revoked.id,
      fromState: "available",
      toState: "revoked",
      reason: "smtp_authentication_failed",
      actor: "system",
    });

    const discoveredFolders = {
      drafts: "Brouillons",
      sent: "Envoyes",
      inbox: "INBOX",
    };
    const result = await connectSmtpImapMailbox(
      db,
      {
        email,
        password: "correct-new-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        imapVerify: async () => discoveredFolders,
        smtpVerify: async () => {},
      },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected the reconnection to succeed");

    // Same row, not a fresh insert -- the whole point of updating rather
    // than inserting is that the unique (provider, normalized_email) index
    // would otherwise refuse a second row for this address.
    expect(result.mailbox.id).toBe(revoked.id);
    expect(result.mailbox.status).toBe("available");

    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, revoked.id));
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("available");
    // A genuinely new ciphertext for the new password, not the stale one.
    expect(stored!.encryptedPassword).not.toBe(revoked.encryptedPassword);
    expect(
      decryptSecret(stored!.encryptedPassword!, connectionKeyring).plaintext,
    ).toBe("correct-new-password");
    // Transport/folders rediscovered, not the stale pre-revocation values.
    expect(stored!.settings).toMatchObject({
      transport: {
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
        folders: discoveredFolders,
      },
    });
    // The sync cursor from before revocation is preserved untouched -- this
    // function never resets it, on either the insert or the update path.
    expect(stored!.syncCursor).toBe("77:120");
    // Fix round 1: the pre-revocation anchor is preserved exactly, not
    // reset to "now - 5 minutes" -- a reset here would silently drop any
    // reply that arrived during the revocation window once the first
    // cursor-less round (there is none here, since a cursor already
    // exists) or a later round finally consults it.
    expect(stored!.lastSyncedAt?.getTime()).toBe(
      preRevocationLastSyncedAt.getTime(),
    );

    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, revoked.id),
        ),
      );
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "revoked",
          toState: "available",
          reason: "smtp_imap_reconnected",
          actor: "operator",
        }),
      ]),
    );

    // Concrete proof of "usable for send again", not just a status flag:
    // enroll a message against this exact mailbox and send it through a
    // provider bound the same way `provider-bootstrap.ts` binds one --
    // `kind: "smtp_imap"`, matching the row's own `provider` column, which
    // is exactly what `send-policy.ts`'s provider-binding check requires.
    const messageFixture = await prepareApprovedMessage({
      reuseMailboxId: revoked.id,
    });
    const workingProvider: MailProvider = {
      kind: "smtp_imap",
      createDraft: async () => ({ draftId: `revived-draft-${suffix}` }),
      sendDraft: async () => ({ status: "accepted" }),
      reconcile: async () => ({
        status: "sent",
        draftId: `revived-draft-${suffix}`,
        providerMessageId: `revived-message-${suffix}`,
        internetMessageId: `<revived-${suffix}@example.com>`,
        conversationId: null,
      }),
    };
    expect(
      await sendApprovedMessage(db, workingProvider, {
        messageId: messageFixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
  });

  it("leaves a revoked mailbox untouched when reconnection is attempted with an invalid credential", async () => {
    const suffix = randomUUID();
    const email = `stays-revoked-${suffix}@example.com`;
    const [revoked] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "smtp_imap",
        email,
        normalizedEmail: email,
        status: "revoked",
        encryptedPassword: encryptSecret(
          "stale-wrong-password",
          connectionKeyring,
        ),
        settings: {
          transport: {
            username: "corentin.sacazes",
            imap: { host: "imap.example.com", port: 993, security: "tls" },
            smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
            folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
          },
        },
      })
      .returning();
    if (!revoked) throw new Error("fixture mailbox missing");

    const result = await connectSmtpImapMailbox(
      db,
      {
        email,
        password: "still-wrong-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        imapVerify: async () => {
          throw new ImapAuthenticationError("bad credentials");
        },
        smtpVerify: async () => {
          throw new Error("unreachable -- IMAP should fail first");
        },
      },
    );
    expect(result).toEqual({ ok: false, code: "IMAP_AUTH_FAILED" });

    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, revoked.id));
    // Completely untouched: no write happens on a failed verification.
    expect(stored).toMatchObject({
      status: "revoked",
      encryptedPassword: revoked.encryptedPassword,
    });
  });

  // Fix round 1: without a shared lock, a repair's own SELECT+write could
  // run fully interleaved with a concurrently in-flight send that is about
  // to revoke the very row being repaired (bound to the *old* password,
  // reaching its own `markMailboxAuthenticationFailed` call *after* the
  // repair already flipped `status` back to `available` -- which is exactly
  // what that function's `WHERE status = 'available'` guard would then
  // match). `connectSmtpImapMailbox`'s write for an existing row now
  // acquires the same `actionLockKey.mailbox(id)` advisory lock
  // `markMailboxAuthenticationFailed`'s callers already hold for their
  // whole attempt -- this proves the mechanism directly: while another
  // operation holds that exact lock, the repair's write provably does not
  // proceed (not merely "eventually succeeds", but observably blocked)
  // until the lock is released, and only then completes.
  it("blocks connectSmtpImapMailbox's write on an existing mailbox until a concurrently held mailbox action lock is released", async () => {
    const suffix = randomUUID();
    const email = `locked-${suffix}@example.com`;
    const [revoked] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "smtp_imap",
        email,
        normalizedEmail: email,
        status: "revoked",
        encryptedPassword: encryptSecret(
          "stale-wrong-password",
          connectionKeyring,
        ),
        settings: {
          transport: {
            username: "corentin.sacazes",
            imap: { host: "imap.example.com", port: 993, security: "tls" },
            smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
            folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
          },
        },
      })
      .returning();
    if (!revoked) throw new Error("fixture mailbox missing");

    const order: string[] = [];
    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holderPromise = withActionLocks(
      db,
      [actionLockKey.mailbox(revoked.id)],
      async () => {
        order.push("holder-acquired");
        await holderGate;
        order.push("holder-released");
      },
    );

    // Let the holder actually acquire the lock before the repair is even
    // attempted -- otherwise the two could race to acquire it in either
    // order, and this test would prove nothing about blocking specifically.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["holder-acquired"]);

    const repairPromise = connectSmtpImapMailbox(
      db,
      {
        email,
        password: "correct-new-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        imapVerify: async () => ({
          drafts: "Drafts",
          sent: "Sent",
          inbox: "INBOX",
        }),
        smtpVerify: async () => {},
      },
    ).then((result) => {
      order.push("repair-completed");
      return result;
    });

    // The repair must not have completed yet -- it is blocked acquiring the
    // same advisory lock the holder is still sitting on.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["holder-acquired"]);

    releaseHolder();
    const [, repairResult] = await Promise.all([holderPromise, repairPromise]);

    expect(order).toEqual([
      "holder-acquired",
      "holder-released",
      "repair-completed",
    ]);
    expect(repairResult).toMatchObject({ ok: true });
  });

  // Task 13: the operator UI now shows "Disconnect" for every non-`mock`
  // provider, not just `microsoft_graph` (`page.tsx`'s
  // `mailbox.provider !== "mock"` check) -- so `disconnectSmtpImapMailbox`
  // must exist and actually behave like the design spec promises
  // ("efface le mot de passe chiffré, le curseur et le transport, exactement
  // comme la déconnexion Microsoft"), the same as `disconnectMicrosoftMailbox`
  // is proven in `microsoft-graph-integration.test.ts`.
  it("disconnects an smtp_imap mailbox: clears password, cursor, and transport, keeps other settings, and moves to disconnected", async () => {
    const suffix = randomUUID();
    const email = `disconnect-${suffix}@example.com`;
    const [connected] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "smtp_imap",
        email,
        normalizedEmail: email,
        status: "available",
        encryptedPassword: encryptSecret("correct-password", connectionKeyring),
        syncCursor: "42:900",
        settings: {
          transport: {
            username: "corentin.sacazes",
            imap: { host: "imap.example.com", port: 993, security: "tls" },
            smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
            folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
          },
          unrelatedKey: "must-survive",
        },
      })
      .returning();
    if (!connected) throw new Error("fixture mailbox missing");

    const result = await disconnectSmtpImapMailbox(db, connected.id);
    expect(result).toEqual({ ok: true });

    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, connected.id));
    expect(stored).toMatchObject({
      status: "disconnected",
      encryptedPassword: null,
      syncCursor: null,
      settings: { unrelatedKey: "must-survive" },
    });
    expect(
      (stored?.settings as Record<string, unknown>)?.transport,
    ).toBeUndefined();

    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityType, "mailbox"),
          eq(schema.stateTransitions.entityId, connected.id),
        ),
      );
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromState: "available",
          toState: "disconnected",
          reason: "smtp_imap_disconnected",
          actor: "operator",
        }),
      ]),
    );

    // Reconnecting afterwards is still `connectSmtpImapMailbox` itself --
    // there is no separate "resume" path, mirroring the revoked-mailbox
    // revival test above.
    const reconnected = await connectSmtpImapMailbox(
      db,
      {
        email,
        password: "fresh-password",
        username: "corentin.sacazes",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: connectionEnvironment,
        imapVerify: async () => ({
          drafts: "Drafts",
          sent: "Sent",
          inbox: "INBOX",
        }),
        smtpVerify: async () => {},
      },
    );
    expect(reconnected).toMatchObject({ ok: true });
    if (!reconnected.ok) throw new Error("expected reconnection to succeed");
    expect(reconnected.mailbox.id).toBe(connected.id);
    expect(reconnected.mailbox.status).toBe("available");
  });

  it("waits for the mailbox action lock before disconnecting", async () => {
    const email = `disconnect-lock-${randomUUID()}@example.com`;
    const [mailbox] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "smtp_imap",
        email,
        normalizedEmail: email,
        status: "available",
        encryptedPassword: encryptSecret("password", connectionKeyring),
        settings: {},
      })
      .returning();
    if (!mailbox) throw new Error("fixture mailbox missing");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = withActionLocks(
      db,
      [actionLockKey.mailbox(mailbox.id)],
      async () => {
        acquired();
        await held;
      },
    );
    await acquiredPromise;
    let completed = false;
    const disconnecting = disconnectSmtpImapMailbox(db, mailbox.id).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const completedWhileHeld = completed;
    release();
    await holder;
    await expect(disconnecting).resolves.toEqual({ ok: true });
    expect(completedWhileHeld).toBe(false);
  });

  it("refuses to disconnect a non-smtp_imap mailbox with NOT_FOUND", async () => {
    const suffix = randomUUID();
    const email = `not-smtp-imap-${suffix}@example.com`;
    const [mock] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "mock",
        email,
        normalizedEmail: email,
        status: "available",
      })
      .returning();
    if (!mock) throw new Error("fixture mailbox missing");

    expect(await disconnectSmtpImapMailbox(db, mock.id)).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mock.id));
    expect(stored).toMatchObject({ status: "available" });
  });

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

  // Live incident, 2026-08-14: an operator approved a message in the review
  // queue and never clicked "Send approved message". The maintenance cycle's
  // recovery stage claimed the `approved` row on its next tick and delivered
  // it 35 seconds after the approval. Approval is a review decision; only an
  // explicit send request may reach the provider. This test runs last in the
  // file because a recovery round touches rows the earlier tests left behind.
  it("never sends an approved message no operator asked to send", async () => {
    const fixture = await prepareApprovedMessage({ mailbox: true });
    const services = createWorkflowTaskServices(db, connectionEnvironment);

    await services["recover-stale-work"]({
      observedAt: new Date().toISOString(),
      limit: 1,
    });

    const [afterRecovery] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(afterRecovery).toMatchObject({
      status: "approved",
      attemptCount: 0,
      sendAttemptToken: null,
      providerDraftId: null,
    });

    // Positive control: nothing else about this fixture blocks delivery, so
    // the assertion above isolates the missing operator decision.
    expect(
      await sendApprovedMessage(db, new DatabaseMockMailProvider(db), {
        messageId: fixture.message.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
  });
});
