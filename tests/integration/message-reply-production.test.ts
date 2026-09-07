import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { stopEnrollment } from "@/modules/campaigns/lifecycle-service";
import { createOrGetContact } from "@/modules/contacts/service";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";
import { SmtpImapMailProvider } from "@/modules/mailboxes/smtp-imap-mail-provider";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import {
  ingestMatchedInboundMessage,
  reconcilePendingInboundRecords,
} from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { updateOperatorSendingSettings } from "@/modules/settings/service";

// The runner chooses the guarded disposable database; every mail operation is injected.
const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });
const classifier = new DeterministicReplyClassifier();
let sequence = 0;
const sentAt = new Date("2026-08-11T10:00:00.000Z");
async function fixture(
  options: {
    oneStep?: boolean;
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
      ...(options.oneStep
        ? []
        : [
            {
              delayMinutes: 60,
              subjectTemplate: "Following up {{first_name}}",
              bodyTemplate: "Follow-up for {{company}}",
            },
          ]),
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

beforeAll(async () => {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  await setPolicySettings();
});
afterAll(async () => client.end());

function delivery(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "hard" | "soft" | "delayed",
) {
  return {
    mailboxId: f.mailbox.id,
    providerMessageId: `audit-${kind}-${sequence}`,
    inReplyTo: f.message.internetMessageId!,
    sender: "postmaster@example.test",
    bouncedRecipient: f.recipient,
    recipient: f.mailbox.email,
    subject: "Delivery report",
    body: "Delivery is still being retried.",
    bounceKind: kind,
    receivedAt: new Date("2026-08-11T10:10:00.000Z"),
  };
}

it("D04 retains a failed soft delivery hold when human nonterminal holds are disabled", async () => {
  const f = await fixture({ holdNonTerminal: false });
  expect(f.enrollment.state).toBe("waiting");
  expect(f.enrollment.nextActionAt).not.toBeNull();
  const result = await ingestMatchedInboundMessage(
    db,
    classifier,
    delivery(f, "soft"),
  );
  expect(result.ok).toBe(true);
  const [current] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  console.log(
    "D04_STATE",
    JSON.stringify({
      state: current!.state,
      nextActionAt: current!.nextActionAt,
      softBounceCount: current!.softBounceCount,
      inboundHoldCount: current!.inboundHoldCount,
    }),
  );
  expect.soft(current!.state).toBe("manual_review");
  expect.soft(current!.nextActionAt).toBeNull();
  expect.soft(current!.softBounceCount).toBe(1);
  expect(
    await ingestMatchedInboundMessage(db, classifier, delivery(f, "soft")),
  ).toMatchObject({ ok: true, disposition: "existing" });
  const [duplicate] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  expect(duplicate!.softBounceCount).toBe(1);
  expect(duplicate!.inboundHoldCount).toBe(0);
});

it("D05 retains delayed DSN semantics after persisted capture and failed finalization", async () => {
  const f = await fixture();
  await client.unsafe(
    "create function audit_fail_reply_insert() returns trigger language plpgsql as $$ begin raise exception 'audit fixture finalization failure'; end $$",
  );
  await client.unsafe(
    "create trigger audit_fail_reply_insert before insert on replies for each row execute function audit_fail_reply_insert()",
  );
  try {
    const initial = await ingestMatchedInboundMessage(
      db,
      classifier,
      delivery(f, "delayed"),
      { now: new Date("2026-08-11T10:10:00.000Z") },
    );
    expect(initial).toEqual({ ok: false, code: "DATABASE_ERROR" });
  } finally {
    await client.unsafe("drop trigger audit_fail_reply_insert on replies");
    await client.unsafe("drop function audit_fail_reply_insert()");
  }
  const [captured] = await db
    .select()
    .from(schema.inboundRecords)
    .where(
      eq(schema.inboundRecords.providerMessageId, `audit-delayed-${sequence}`),
    );
  expect(captured!.metadata.bounceKind).toBe("delayed");
  expect(captured!.status).toBe("processing");
  const [held] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  expect(held!.inboundHoldCount).toBe(1);
  const results = await reconcilePendingInboundRecords(db, classifier, {
    now: new Date("2026-08-11T10:20:00.000Z"),
  });
  expect(results).toHaveLength(1);
  expect(results[0]!.ok).toBe(true);
  const [current] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  const [reply] = await db
    .select()
    .from(schema.replies)
    .where(eq(schema.replies.inboundRecordId, captured!.id));
  console.log(
    "D05_REPLAY",
    JSON.stringify({
      classification: reply!.classification,
      state: current!.state,
      nextActionAt: current!.nextActionAt,
      softBounceCount: current!.softBounceCount,
    }),
  );
  expect.soft(current!.state).toBe("waiting");
  expect.soft(current!.nextActionAt).toEqual(f.enrollment.nextActionAt);
  expect.soft(current!.softBounceCount).toBe(0);
  expect(current!.nextActionToken).toBe(f.enrollment.nextActionToken);
  expect(current!.inboundHoldCount).toBe(0);
  expect(
    await reconcilePendingInboundRecords(db, classifier, {
      now: new Date("2026-08-11T10:21:00.000Z"),
    }),
  ).toEqual([]);
});

it("D08 does not persist arbitrary numbered SMTP failure prose", async () => {
  const f = await fixture({ send: false });
  const sentinel = "AUDIT_SYNTHETIC_PASSWORD_DO_NOT_PERSIST";
  const provider = {
    kind: "mock" as const,
    createDraft: async () => ({ draftId: "audit-draft" }),
    sendDraft: async () => {
      throw Object.assign(new Error("SMTP failed"), {
        responseCode: 451,
        response: `451 4.3.0 ${sentinel} ${"x".repeat(20000)}`,
      });
    },
    reconcile: async () => ({
      status: "drafted" as const,
      draftId: "audit-draft",
    }),
  };
  const result = await sendApprovedMessage(
    db,
    provider,
    { messageId: f.message.id },
    { clock: () => sentAt },
  );
  expect(result).toEqual({ ok: false, code: "DELIVERY_UNCERTAIN" });
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, f.message.id));
  const events = await db
    .select()
    .from(schema.workflowEvents)
    .where(eq(schema.workflowEvents.entityId, f.message.id));
  console.log(
    "D08_PERSISTED",
    JSON.stringify({
      messageContainsSentinel: message!.lastError!.includes(sentinel),
      messageErrorLength: message!.lastError!.length,
      eventContainsSentinel: JSON.stringify(events).includes(sentinel),
    }),
  );
  expect.soft(message!.lastError!.includes(sentinel)).toBe(false);
  expect.soft(message!.lastError!.length).toBeLessThan(500);
  expect.soft(JSON.stringify(events).includes(sentinel)).toBe(false);
});

it("D08 bounds permanent rejection diagnostics and suppression notes", async () => {
  const f = await fixture({ send: false });
  const sentinel = "AUDIT_SYNTHETIC_REJECTION_SECRET";
  const rejection = {
    status: "rejected" as const,
    draftId: "audit-rejected",
    responseCode: 550,
    response: `550 5.1.1 ${sentinel} ${"x".repeat(20000)}`,
    hardBounce: true,
  };
  const provider = {
    kind: "mock" as const,
    createDraft: async () => ({ draftId: "audit-rejected" }),
    sendDraft: async () => ({ status: "accepted" as const }),
    reconcile: async () => rejection,
  };
  expect(
    await sendApprovedMessage(
      db,
      provider,
      { messageId: f.message.id },
      { clock: () => sentAt },
    ),
  ).toEqual({ ok: false, code: "PERMANENT_REJECTION" });
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, f.message.id));
  const events = await db
    .select()
    .from(schema.workflowEvents)
    .where(eq(schema.workflowEvents.entityId, f.message.id));
  const [suppression] = await db
    .select()
    .from(schema.suppressionEntries)
    .where(eq(schema.suppressionEntries.normalizedValue, f.recipient));
  expect(message!.status).toBe("failed");
  expect(suppression!.reason).toBe("hard_bounce");
  expect.soft(message!.lastError).toContain("550");
  expect.soft(message!.lastError!.includes(sentinel)).toBe(false);
  expect.soft(message!.lastError!.length).toBeLessThan(500);
  expect.soft(JSON.stringify(events).includes(sentinel)).toBe(false);
  expect.soft(suppression!.notes!.includes(sentinel)).toBe(false);
});

it.each([true, false])(
  "D08 journal persists bounded diagnostic while preserving release=%s",
  async (releaseAttempt) => {
    const journal = new WorkflowEventsSendJournal(db);
    const key = `audit-journal-${releaseAttempt}`;
    const sentinel = "AUDIT_SYNTHETIC_JOURNAL_SECRET";
    expect(await journal.recordAttempt(key)).toBe(true);
    const responseCode = releaseAttempt ? 451 : 550;
    await journal.recordRejection(key, {
      responseCode,
      response: `${responseCode} 5.1.1 ${sentinel} ${"x".repeat(20000)}`,
      smtpErrorCode: "EENVELOPE",
      releaseAttempt,
    });
    expect(await journal.hasAttempt(key)).toBe(!releaseAttempt);
    expect(await journal.hasAcceptance(key)).toBe(false);
    const [record] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.event, "smtp.rejected"))
      .then((rows) => rows.filter((row) => row.payload.messageKey === key));
    expect(record!.payload.responseCode).toBe(responseCode);
    expect(record!.payload.smtpErrorCode).toBe("EENVELOPE");
    expect(record!.payload.released).toBe(releaseAttempt);
    expect.soft(JSON.stringify(record).includes(sentinel)).toBe(false);
    expect.soft(record!.error!.length).toBeLessThan(500);
    const permanent = await journal.getPermanentRejection(key);
    if (releaseAttempt) expect(permanent).toBeNull();
    else {
      expect(permanent).toMatchObject({
        responseCode: 550,
        smtpErrorCode: "EENVELOPE",
        releaseAttempt: false,
      });
      expect.soft(JSON.stringify(permanent).includes(sentinel)).toBe(false);
    }
  },
);

it.each([
  { smtpErrorCode: "EENVELOPE", status: "5.1.1", hardBounce: true },
  { smtpErrorCode: "EMESSAGE", status: "5.2.3", hardBounce: false },
])(
  "D08 provider still interprets journal status $status ($smtpErrorCode)",
  async ({ smtpErrorCode, status, hardBounce }) => {
    const outreachId = `diagnostic-${smtpErrorCode}`;
    const journal = new WorkflowEventsSendJournal(db);
    const key = outreachMessageId(outreachId, "example.test");
    await journal.recordAttempt(key);
    await journal.recordRejection(key, {
      responseCode: 550,
      response: `550 ${status} AUDIT_SYNTHETIC_SECRET`,
      smtpErrorCode,
      releaseAttempt: false,
    });
    // The permanent-journal branch must require no transport operation.
    const unavailablePort = new Proxy(
      {},
      {
        get: () => {
          throw new Error("Unexpected transport access");
        },
      },
    );
    const provider = new SmtpImapMailProvider(
      unavailablePort as never,
      unavailablePort as never,
      "11111111-1111-4111-8111-111111111111",
      "operator@example.test",
      journal,
    );
    expect(
      await provider.reconcile({
        outreachId,
        draftId: "audit-existing-draft",
        mailboxId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      status: "rejected",
      draftId: "audit-existing-draft",
      responseCode: 550,
      response: `SMTP 550 ${status}`,
      smtpErrorCode,
      hardBounce,
    });
  },
);

it("D08 journal does not persist unknown error codes or malformed numeric status", async () => {
  const journal = new WorkflowEventsSendJournal(db);
  const key = "diagnostic-invalid";
  await journal.recordRejection(key, {
    responseCode: Number.NaN,
    response: "550 5.1.1 AUDIT_SYNTHETIC_SECRET",
    smtpErrorCode: "AUDIT_SYNTHETIC_ERROR_SECRET",
    releaseAttempt: true,
  });
  const rows = await db
    .select()
    .from(schema.workflowEvents)
    .where(eq(schema.workflowEvents.event, "smtp.rejected"));
  const record = rows.find((row) => row.payload.messageKey === key)!;
  expect(record.error).toBe("SMTP rejection");
  expect(record.payload).toEqual({
    messageKey: key,
    responseCode: null,
    response: "SMTP rejection",
    smtpErrorCode: null,
    released: true,
  });
});

it.each([false, true])(
  "keeps a pending delayed report held while confirmation updates its saved progression (oneStep=%s)",
  async (oneStep) => {
    const f = await fixture({ send: false, oneStep });
    const provider = new MockMailProvider({ confirmation: "manual" });
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: f.message.id },
        { clock: () => sentAt },
      ),
    ).toEqual({ ok: false, code: "DELIVERY_UNCERTAIN" });
    const input = {
      ...delivery(f, "delayed"),
      inReplyTo: undefined,
      outreachId: f.message.outreachId!,
    };
    await client.unsafe(
      "create function audit_fail_reply_insert() returns trigger language plpgsql as $$ begin raise exception 'audit finalization failure'; end $$",
    );
    await client.unsafe(
      "create trigger audit_fail_reply_insert before insert on replies for each row execute function audit_fail_reply_insert()",
    );
    try {
      expect(
        await ingestMatchedInboundMessage(db, classifier, input, {
          now: new Date("2026-08-11T10:10:00.000Z"),
        }),
      ).toEqual({ ok: false, code: "DATABASE_ERROR" });
    } finally {
      await client.unsafe("drop trigger audit_fail_reply_insert on replies");
      await client.unsafe("drop function audit_fail_reply_insert()");
    }
    provider.confirm(f.message.outreachId!, f.mailbox.id);
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: f.message.id },
        { clock: () => sentAt },
      ),
    ).toMatchObject({ ok: true, disposition: "sent" });
    const [held] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect.soft(held).toMatchObject({
      state: "manual_review",
      inboundHoldCount: 1,
      nextActionAt: null,
      nextActionToken: null,
      stopReason: null,
    });
    expect
      .soft(held!.inboundHoldPreviousState)
      .toBe(oneStep ? "completed" : "waiting");
    const due = oneStep ? null : new Date("2026-08-11T11:00:00.000Z");
    expect.soft(held!.inboundHoldPreviousNextActionAt).toEqual(due);
    const events = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, f.enrollment.id));
    const scheduled = events.filter((e) => e.event === "follow_up.scheduled");
    expect.soft(scheduled).toHaveLength(oneStep ? 0 : 1);
    if (!oneStep)
      expect.soft(scheduled[0]).toMatchObject({
        scheduledAt: due,
        payload: {
          expectedToken: held!.inboundHoldPreviousNextActionToken,
          expectedDueAt: due!.toISOString(),
        },
      });
    const replay = await reconcilePendingInboundRecords(db, classifier, {
      now: new Date("2026-08-11T10:20:00.000Z"),
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ ok: true, disposition: "processed" });
    const [resumed] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect.soft(resumed).toMatchObject({
      state: oneStep ? "completed" : "waiting",
      currentStep: oneStep ? 0 : 1,
      nextActionAt: due,
      nextActionToken: held!.inboundHoldPreviousNextActionToken,
      inboundHoldCount: 0,
      stopReason: oneStep ? "sequence_complete" : null,
      stoppedAt: oneStep ? sentAt : null,
    });
    expect(
      await reconcilePendingInboundRecords(db, classifier, {
        now: new Date("2026-08-11T10:21:00.000Z"),
      }),
    ).toEqual([]);
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: f.message.id },
        { clock: () => sentAt },
      ),
    ).toMatchObject({ ok: true, disposition: "already_sent" });
    expect(provider.deliveries).toHaveLength(1);
    expect(provider.sendDraftCalls).toHaveLength(1);
    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, f.enrollment.id));
    expect(
      transitions.filter(
        (t) =>
          t.fromState === "manual_review" &&
          t.toState === (oneStep ? "completed" : "waiting"),
      ),
    ).toHaveLength(1);
  },
);

it("never revives an operator stop when an older delayed report is replayed", async () => {
  const f = await fixture();
  const input = delivery(f, "delayed");
  await client.unsafe(
    "create function audit_fail_reply_insert() returns trigger language plpgsql as $$ begin raise exception 'audit finalization failure'; end $$",
  );
  await client.unsafe(
    "create trigger audit_fail_reply_insert before insert on replies for each row execute function audit_fail_reply_insert()",
  );
  try {
    expect(
      await ingestMatchedInboundMessage(db, classifier, input, {
        now: new Date("2026-08-11T10:10:00.000Z"),
      }),
    ).toEqual({ ok: false, code: "DATABASE_ERROR" });
  } finally {
    await client.unsafe("drop trigger audit_fail_reply_insert on replies");
    await client.unsafe("drop function audit_fail_reply_insert()");
  }
  expect(
    await stopEnrollment(db, {
      enrollmentId: f.enrollment.id,
      actor: "audit-operator",
    }),
  ).toMatchObject({ ok: true, disposition: "stopped" });
  const [stopped] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  expect(
    await reconcilePendingInboundRecords(db, classifier, {
      now: new Date("2026-08-11T10:20:00.000Z"),
    }),
  ).toHaveLength(1);
  const [replayed] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, f.enrollment.id));
  expect(replayed).toMatchObject({
    state: "stopped",
    stopReason: "manual_stop",
    stoppedAt: stopped!.stoppedAt,
    nextActionAt: null,
    nextActionToken: null,
    inboundHoldCount: 0,
  });
  expect(f.provider.deliveries).toHaveLength(1);
});

it.each([
  ...(
    [
      { first: "soft", second: "delayed", state: "manual_review" },
      { first: "delayed", second: "soft", state: "manual_review" },
      { first: "automated", second: "delayed", state: "manual_review" },
      { first: "delayed", second: "automated", state: "manual_review" },
      { first: "hard", second: "delayed", state: "bounced" },
      { first: "delayed", second: "hard", state: "bounced" },
      { first: "unsubscribe", second: "delayed", state: "opted_out" },
      { first: "delayed", second: "unsubscribe", state: "opted_out" },
    ] as const
  ).map((row) => ({ ...row, confirmBetween: false, oneStep: false })),
  {
    first: "soft",
    second: "delayed",
    state: "manual_review",
    confirmBetween: true,
    oneStep: false,
  },
  {
    first: "automated",
    second: "delayed",
    state: "manual_review",
    confirmBetween: true,
    oneStep: false,
  },
  {
    first: "soft",
    second: "delayed",
    state: "manual_review",
    confirmBetween: true,
    oneStep: true,
  },
  {
    first: "automated",
    second: "delayed",
    state: "manual_review",
    confirmBetween: true,
    oneStep: true,
  },
] as const)(
  "preserves $first / $second decisions when two durable captures replay separately (confirmation=$confirmBetween, oneStep=$oneStep)",
  async ({ first, second, state, confirmBetween, oneStep }) => {
    const f = await fixture({ send: !confirmBetween, oneStep });
    const provider = confirmBetween
      ? new MockMailProvider({ confirmation: "manual" })
      : f.provider;
    if (confirmBetween)
      expect(
        await sendApprovedMessage(
          db,
          provider,
          { messageId: f.message.id },
          { clock: () => sentAt },
        ),
      ).toEqual({ ok: false, code: "DELIVERY_UNCERTAIN" });
    await client.unsafe(
      "create function audit_fail_reply_insert() returns trigger language plpgsql as $$ begin raise exception 'audit finalization failure'; end $$",
    );
    await client.unsafe(
      "create trigger audit_fail_reply_insert before insert on replies for each row execute function audit_fail_reply_insert()",
    );
    try {
      for (const [index, kind] of [first, second].entries()) {
        const input = {
          ...delivery(f, "delayed"),
          ...(confirmBetween
            ? { inReplyTo: undefined, outreachId: f.message.outreachId! }
            : {}),
          providerMessageId: `mixed-${sequence}-${index}`,
          ...(kind === "automated" || kind === "unsubscribe"
            ? {
                bounceKind: null,
                sender: f.recipient,
                bouncedRecipient: undefined,
                body:
                  kind === "automated"
                    ? "Automated message, do not reply"
                    : "Please unsubscribe me",
              }
            : { bounceKind: kind }),
        };
        expect(
          await ingestMatchedInboundMessage(db, classifier, input, {
            now: new Date(`2026-08-11T10:${10 + index}:00.000Z`),
          }),
        ).toEqual({ ok: false, code: "DATABASE_ERROR" });
      }
    } finally {
      await client.unsafe("drop trigger audit_fail_reply_insert on replies");
      await client.unsafe("drop function audit_fail_reply_insert()");
    }
    const [held] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    expect(held).toMatchObject({
      state: "manual_review",
      inboundHoldCount: 2,
      inboundHoldPreviousState: confirmBetween ? "approved" : "waiting",
    });
    for (const minute of [30, 31]) {
      const results = await reconcilePendingInboundRecords(db, classifier, {
        limit: 1,
        now: new Date(`2026-08-11T10:${minute}:00.000Z`),
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ ok: true, disposition: "processed" });
      if (minute === 30 && confirmBetween) {
        provider.confirm(f.message.outreachId!, f.mailbox.id);
        expect(
          await sendApprovedMessage(
            db,
            provider,
            { messageId: f.message.id },
            { clock: () => sentAt },
          ),
        ).toMatchObject({ ok: true, disposition: "sent" });
      }
    }
    const [current] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, f.enrollment.id));
    console.log(
      "MIXED_REPLAY",
      JSON.stringify({
        first,
        second,
        confirmBetween,
        state: current!.state,
        holdCount: current!.inboundHoldCount,
        softBounceCount: current!.softBounceCount,
        nextActionAt: current!.nextActionAt,
      }),
    );
    expect.soft(current).toMatchObject({
      state,
      currentStep: oneStep ? 0 : 1,
      inboundHoldCount: 0,
      nextActionAt: null,
      nextActionToken: null,
      softBounceCount: first === "soft" || second === "soft" ? 1 : 0,
      stopReason:
        state === "bounced"
          ? "hard_bounce"
          : state === "opted_out"
            ? "unsubscribe"
            : null,
    });
    expect(
      await reconcilePendingInboundRecords(db, classifier, {
        now: new Date("2026-08-11T10:32:00.000Z"),
      }),
    ).toEqual([]);
    if (confirmBetween) {
      const events = await db
        .select()
        .from(schema.workflowEvents)
        .where(eq(schema.workflowEvents.entityId, f.enrollment.id));
      expect(
        events.filter((event) => event.event === "follow_up.scheduled"),
      ).toEqual([]);
    }
    expect(provider.deliveries).toHaveLength(1);
    expect(provider.sendDraftCalls).toHaveLength(1);
  },
);
