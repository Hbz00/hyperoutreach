import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { MockDnsMxResolver } from "@/modules/email-resolution/dns";
import { StaticPublicEmailEvidenceProvider } from "@/modules/email-resolution/public-evidence-provider";
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";
import { resolveContactEmail } from "@/modules/email-resolution/service";
import {
  liftConventionDemotion,
  readAddressLadderMetrics,
  readConventionDemotionRecords,
  readConventionOutcomes,
  readBlockedRungs,
  readLadderSettings,
} from "@/modules/email-resolution/ladder-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import type { MailProvider } from "@/modules/mailboxes/mail-provider";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { generateWithPersonalization } from "@/modules/messages/personalized-generation";
import { MockPersonalizationAgent } from "@/modules/agents/mock-agents";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { listSuppressions } from "@/modules/suppression/service";
import { findDueEnrollments } from "@/modules/workflows/follow-up-service";
import { readParkedEnrollments } from "@/modules/workflows/parked-enrollments";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 8 });
const db = drizzle(client, { schema });
const classifier = new DeterministicReplyClassifier();

const sentAt = new Date("2026-08-18T10:00:00.000Z");
const bouncedAt = new Date("2026-08-18T10:30:00.000Z");
let sequence = 0;

/**
 * A company whose public evidence names two conventions with different sample
 * counts, so the contact holds an unambiguous two-rung ladder.
 *
 * `first.last` gets three unambiguous samples (0.97) and `f.last` two (0.90).
 * Nothing here is tied: the point of most of these tests is what happens when
 * rung one turns out not to exist, not how ties are ordered.
 */
async function ladderFixture(
  options: {
    send?: boolean;
    extraContacts?: number;
    steps?: number;
    /** Declares an agent-written sentence on step zero. */
    personalized?: boolean;
  } = {},
) {
  sequence += 1;
  const n = sequence;
  const domain = `ladder-${n}.example`;
  const account = await createOrGetAccount(db, {
    name: `Ladder ${n}`,
    domain,
  });
  if (!account.ok) throw new Error(account.message);
  await db.insert(schema.evidenceSources).values({
    accountId: account.account.id,
    url: `https://${domain}/about`,
    sourceType: "company_website",
    supports: ["identity", "domain"],
    confidence: "0.990",
  });
  if (options.personalized) {
    await db
      .update(schema.accounts)
      .set({
        researchStatus: "complete",
        researchSnapshot: { summary: "Runs a regional depot network" },
        researchedAt: new Date("2026-08-17T09:00:00.000Z"),
      })
      .where(eq(schema.accounts.id, account.account.id));
    await db.insert(schema.evidenceSources).values({
      accountId: account.account.id,
      url: `https://${domain}/news`,
      sourceType: "company_website",
      supports: ["signal"],
    });
  }
  const source = `https://${domain}/press.pdf`;
  const publicSamples = [
    {
      firstName: "Marie",
      lastName: "Durand",
      email: `marie.durand@${domain}`,
      sourceUrl: source,
    },
    {
      firstName: "Paul",
      lastName: "Martin",
      email: `paul.martin@${domain}`,
      sourceUrl: source,
    },
    {
      firstName: "Remi",
      lastName: "Petit",
      email: `remi.petit@${domain}`,
      sourceUrl: source,
    },
    {
      firstName: "Jean",
      lastName: "Dupont",
      email: `j.dupont@${domain}`,
      sourceUrl: source,
    },
    {
      firstName: "Luc",
      lastName: "Bernard",
      email: `l.bernard@${domain}`,
      sourceUrl: source,
    },
  ];

  const resolve = async (contactId: string) =>
    resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId },
      {
        publicEvidenceProvider: new StaticPublicEmailEvidenceProvider(
          publicSamples,
        ),
      },
    );

  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Alice",
    lastName: `Rung${n}`,
    jobTitle: "Directrice",
    professionalRelevance: { relevant: true, reason: "Operations leader" },
  });
  if (!contact.ok) throw new Error(contact.message);
  const resolved = await resolve(contact.contact.id);
  if (!resolved.ok || resolved.status !== "resolved") {
    throw new Error(
      `ladder fixture did not resolve: ${JSON.stringify(resolved)}`,
    );
  }

  const colleagues = [];
  for (let index = 0; index < (options.extraContacts ?? 0); index += 1) {
    const colleague = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: `Colleague${index}`,
      lastName: `Peer${index}Rung${n}`,
      jobTitle: "Acheteur",
      professionalRelevance: { relevant: true, reason: "Buyer" },
    });
    if (!colleague.ok) throw new Error(colleague.message);
    await resolve(colleague.contact.id);
    colleagues.push(colleague.contact);
  }

  const campaign = await createDraftCampaign(db, {
    name: `Ladder campaign ${n}`,
    type: "commercial_outreach",
    targetDescription: "Operations leaders at mid-market carriers",
    configuration: {
      automaticFollowUps: false,
      holdNonTerminalReplies: true,
      requireProfessionalRelevance: false,
      campaignDailyCap: 100,
    },
    steps: Array.from({ length: options.steps ?? 2 }, (_unused, index) => ({
      delayMinutes: index === 0 ? 0 : 60,
      subjectTemplate: `Step ${index} {{first_name}}`,
      bodyTemplate:
        options.personalized && index === 0
          ? `{{personalized_opening}} — step ${index} for {{company}}`
          : `Body ${index} for {{company}}`,
      ...(options.personalized && index === 0
        ? {
            personalizationSchema: {
              fields: ["personalized_opening" as const],
              minConfidence: 0.5,
            },
          }
        : {}),
    })),
  });
  if (!campaign.ok) throw new Error(campaign.message);
  const published = await publishCampaignVersion(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
  });
  if (!published.ok) throw new Error(published.message);
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "mock",
      email: `operator-ladder-${n}@example.com`,
      normalizedEmail: `operator-ladder-${n}@example.com`,
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

  const rungOne = `alice.rung${n}@${domain}`;
  const rungTwo = `a.rung${n}@${domain}`;
  const provider = new MockMailProvider();
  let message = null as null | typeof schema.messages.$inferSelect;
  if (options.send !== false) {
    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: rungOne,
      ...(options.personalized
        ? {
            personalization: {
              fields: [
                {
                  name: "personalized_opening" as const,
                  value: "Saw your depot expansion",
                  confidence: 0.9,
                  sourceUrls: [`https://${domain}/news`],
                },
              ],
            },
          }
        : {}),
    });
    if (!proposal.ok) throw new Error(proposal.message);
    const review = await reviewMessage(db, {
      messageId: proposal.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!review.ok) throw new Error(review.message);
    const sent = await sendApprovedMessage(
      db,
      provider,
      { messageId: proposal.message.id },
      { clock: () => sentAt },
    );
    if (!sent.ok) throw new Error(sent.code);
    message = sent.message;
  }

  return {
    account: account.account,
    campaign: campaign.campaign,
    colleagues,
    contact: contact.contact,
    domain,
    enrollmentId: enrollment.enrollment.id,
    mailbox,
    message,
    provider,
    resolve,
    publicSamples,
    rungOne,
    rungTwo,
    version: campaign.version,
  };
}

async function hardBounce(
  fixture: Awaited<ReturnType<typeof ladderFixture>>,
  overrides: { bouncedRecipient?: string; receivedAt?: Date } = {},
) {
  if (!fixture.message) throw new Error("nothing was sent to bounce");
  sequence += 1;
  return ingestInboundMessage(db, classifier, {
    mailboxId: fixture.mailbox.id,
    providerMessageId: `dsn-ladder-${sequence}`,
    outreachId: fixture.message.outreachId ?? undefined,
    conversationId: fixture.message.conversationId ?? undefined,
    inReplyTo: fixture.message.internetMessageId ?? undefined,
    sender: "postmaster@example.net",
    recipient: fixture.mailbox.email,
    bouncedRecipient: overrides.bouncedRecipient ?? fixture.rungOne,
    subject: "Delivery status notification",
    body: "Recipient address rejected: user unknown",
    bounceKind: "hard" as const,
    receivedAt: overrides.receivedAt ?? bouncedAt,
  });
}

async function awaitingReview(enrollmentId: string) {
  await db
    .update(schema.enrollments)
    .set({ state: "ready_for_review" })
    .where(eq(schema.enrollments.id, enrollmentId));
}

async function candidates(contactId: string) {
  return db
    .select()
    .from(schema.emailCandidates)
    .where(eq(schema.emailCandidates.contactId, contactId))
    .orderBy(asc(schema.emailCandidates.ladderRank));
}

async function enrollmentRow(enrollmentId: string) {
  const [row] = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.id, enrollmentId))
    .limit(1);
  if (!row) throw new Error("enrollment missing");
  return row;
}

async function setLadderSettings(
  overrides: Partial<{
    addressLadderEnabled: boolean;
    addressLadderMaxRungs: number;
    addressLadderMaxAdvancesPerAccountPerDay: number;
    addressLadderFailureRatePercent: number;
    addressLadderFailureRateMinimumSends: number;
    addressLadderDemotionMinimumPeople: number;
    addressLadderDemotionFailureSharePercent: number;
  }>,
) {
  await db
    .insert(schema.operatorSendingSettings)
    .values({ id: 1 })
    .onConflictDoNothing();
  await db
    .update(schema.operatorSendingSettings)
    .set({
      addressLadderEnabled: true,
      addressLadderMaxRungs: 3,
      addressLadderMaxAdvancesPerAccountPerDay: 2,
      addressLadderFailureRatePercent: 30,
      addressLadderFailureRateMinimumSends: 1_000,
      addressLadderDemotionMinimumPeople: 2,
      addressLadderDemotionFailureSharePercent: 50,
      ...overrides,
    })
    .where(eq(schema.operatorSendingSettings.id, 1));
}

describe("address attempt ladder", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    await setLadderSettings({});
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * A bound the operator cannot change is not a bound, it is a constant with a
   * text field in front of it. These go through the real update path, schema
   * validation included.
   */
  it("persists every ladder bound the operator can set, and refuses nonsense", async () => {
    const saved = await updateOperatorSendingSettings(db, {
      addressLadderEnabled: false,
      addressLadderMaxRungs: 5,
      addressLadderMaxAdvancesPerAccountPerDay: 7,
      addressLadderFailureRatePercent: 42,
      addressLadderFailureRateMinimumSends: 11,
      addressLadderDemotionMinimumPeople: 3,
      addressLadderDemotionFailureSharePercent: 60,
      actor: "operator@example.com",
    });
    expect(saved).toMatchObject({ ok: true });
    expect(await readLadderSettings(db)).toEqual({
      enabled: false,
      maxRungs: 5,
      maxAdvancesPerAccountPerDay: 7,
      failureRatePercent: 42,
      failureRateMinimumSends: 11,
      demotionMinimumPeople: 3,
      demotionFailureSharePercent: 60,
    });

    // One failure never demotes anything, so two is a floor the schema keeps.
    expect(
      await updateOperatorSendingSettings(db, {
        addressLadderDemotionMinimumPeople: 1,
        actor: "operator@example.com",
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    // A breaker that trips at 0% would disable the feature permanently, and one
    // above 100% could never trip at all.
    for (const percent of [0, 101]) {
      expect(
        await updateOperatorSendingSettings(db, {
          addressLadderFailureRatePercent: percent,
          actor: "operator@example.com",
        }),
      ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(
      await updateOperatorSendingSettings(db, {
        addressLadderMaxRungs: 0,
        actor: "operator@example.com",
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    // Nothing partial was written by any of those refusals.
    expect(await readLadderSettings(db)).toMatchObject({
      demotionMinimumPeople: 3,
      failureRatePercent: 42,
      maxRungs: 5,
    });
    await setLadderSettings({});
  });

  it("stamps the attempt clock on the rung a send actually used", async () => {
    const fixture = await ladderFixture();
    const rows = await candidates(fixture.contact.id);
    const attempted = rows.filter((row) => row.firstAttemptedAt !== null);
    expect(attempted.map((row) => row.normalizedEmail)).toEqual([
      fixture.rungOne,
    ]);
    // Never "delivered": nothing here claims the message arrived.
    expect(attempted[0]?.deadAt).toBeNull();
  });

  it("advances to the next rung on a hard bounce and keeps the dead address suppressed", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    const result = await hardBounce(fixture);
    expect(result).toMatchObject({ ok: true, disposition: "processed" });

    // The suppression of the dead address is permanent, and unchanged.
    const suppressions = await listSuppressions(db, { scope: "email" });
    expect(suppressions.map((entry) => entry.normalizedValue)).toContain(
      fixture.rungOne,
    );

    const rows = await candidates(fixture.contact.id);
    const rungOne = rows.find((row) => row.normalizedEmail === fixture.rungOne);
    const rungTwo = rows.find((row) => row.normalizedEmail === fixture.rungTwo);
    expect(rungOne).toMatchObject({ status: "rejected" });
    expect(rungOne?.deadAt).not.toBeNull();
    expect(rungOne?.deadMessageId).toBe(fixture.message?.id);
    expect(rungTwo).toMatchObject({ status: "accepted" });
    expect(rungTwo?.advancedAt).not.toBeNull();

    // The message that proved it is marked, which is what frees the step.
    const [dead] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message!.id))
      .limit(1);
    expect(dead?.addressDeadAt).not.toBeNull();

    // The person is not done: a non-terminal state, back at the dead step, with
    // no schedule and no stop reason.
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "manual_review",
      currentStep: 0,
      stopReason: null,
      nextActionAt: null,
      nextActionToken: null,
    });
    // Follow-up timing counts from the most recent attempt that was not proven
    // dead — here, none at all.
    expect(enrollment.lastMessageAt).toBeNull();
    // The reply records what actually happened to the sequence.
    const [reply] = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.enrollmentId, fixture.enrollmentId))
      .limit(1);
    expect(reply).toMatchObject({
      classification: "bounce",
      terminatesSequence: false,
    });
    // And the re-addressed message is queued rather than sent.
    const queued = await db
      .select()
      .from(schema.operatorCommands)
      .where(eq(schema.operatorCommands.command, "generate-message"));
    expect(
      queued.filter((row) => row.payload.enrollmentId === fixture.enrollmentId)
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("generates the re-addressed message to the next rung at the same step", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await hardBounce(fixture);

    const regenerated = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 0,
      recipient: fixture.rungTwo,
    });
    if (!regenerated.ok)
      throw new Error(`regeneration failed: ${JSON.stringify(regenerated)}`);
    expect(regenerated).toMatchObject({ ok: true, disposition: "created" });
    expect(regenerated.message.recipient).toBe(fixture.rungTwo);
    // Still the first message: the step was not consumed.
    expect(regenerated.message.stepIndex).toBe(0);
    const live = await db
      .select({ recipient: schema.messages.recipient })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.enrollmentId, fixture.enrollmentId),
          isNull(schema.messages.addressDeadAt),
        ),
      );
    expect(live.map((row) => row.recipient)).toEqual([fixture.rungTwo]);
    // It waits for the operator, exactly as a first message does.
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment.state).toBe("ready_for_review");
    expect(regenerated.message.status).toBe("proposed");
  });

  it("reaches the same terminal state as a bounce once the ladder is exhausted", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await hardBounce(fixture);

    // Spend rung two as well.
    const regenerated = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 0,
      recipient: fixture.rungTwo,
    });
    if (!regenerated.ok) throw new Error("regeneration failed");
    const review = await reviewMessage(db, {
      messageId: regenerated.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!review.ok) throw new Error(review.message);
    const sent = await sendApprovedMessage(
      db,
      fixture.provider,
      { messageId: regenerated.message.id },
      { clock: () => new Date("2026-08-19T10:00:00.000Z") },
    );
    if (!sent.ok) throw new Error(sent.code);
    const secondBounce = await ingestInboundMessage(db, classifier, {
      mailboxId: fixture.mailbox.id,
      providerMessageId: `dsn-exhausted-${sequence}`,
      outreachId: sent.message.outreachId ?? undefined,
      sender: "postmaster@example.net",
      recipient: fixture.mailbox.email,
      bouncedRecipient: fixture.rungTwo,
      subject: "Delivery status notification",
      body: "Recipient address rejected: user unknown",
      bounceKind: "hard" as const,
      receivedAt: new Date("2026-08-19T10:30:00.000Z"),
    });
    expect(secondBounce).toMatchObject({ ok: true, disposition: "processed" });

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
    });
    // The distinct, visible outcome lives where "no further address to try"
    // belongs — on the contact's address, not on the sequence.
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    expect(contact).toMatchObject({
      emailResolutionStatus: "unresolved",
      emailResolutionReason: "ladder_exhausted",
    });
    const rows = await candidates(fixture.contact.id);
    expect(rows.every((row) => row.deadAt !== null)).toBe(true);
    expect(rows.every((row) => row.status === "rejected")).toBe(true);
  });

  it("never re-addresses a person whose earlier send produced no delivery failure", async () => {
    await setLadderSettings({});
    // Three steps, so sending step one leaves the sequence running: a bounce on
    // an already-terminal enrollment would prove nothing about this rule.
    const fixture = await ladderFixture({ steps: 3 });
    // Step zero went out and nothing came back — the prospect may hold it.
    // A hard bounce on a later step must not start guessing addresses.
    const followUp = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 1,
      recipient: fixture.rungOne,
    });
    if (!followUp.ok) throw new Error(followUp.message);
    await awaitingReview(fixture.enrollmentId);
    const review = await reviewMessage(db, {
      messageId: followUp.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!review.ok) throw new Error(review.message);
    const sent = await sendApprovedMessage(
      db,
      fixture.provider,
      { messageId: followUp.message.id },
      { clock: () => new Date("2026-08-19T12:00:00.000Z") },
    );
    if (!sent.ok) throw new Error(sent.code);

    const bounce = await ingestInboundMessage(db, classifier, {
      mailboxId: fixture.mailbox.id,
      providerMessageId: `dsn-outstanding-${sequence}`,
      outreachId: sent.message.outreachId ?? undefined,
      sender: "postmaster@example.net",
      recipient: fixture.mailbox.email,
      bouncedRecipient: fixture.rungOne,
      subject: "Delivery status notification",
      body: "Recipient address rejected: user unknown",
      bounceKind: "hard" as const,
      receivedAt: new Date("2026-08-19T12:30:00.000Z"),
    });
    expect(bounce).toMatchObject({ ok: true, disposition: "processed" });

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
    });
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
  });

  /**
   * Only an *attempted* message blocks. A proposal nobody approved has reached
   * nobody, and treating it as outstanding would freeze the ladder for every
   * prospect whose next step happens to be drafted ahead of time.
   */
  it("does not let an unapproved proposal block an advance", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ steps: 3 });
    const drafted = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 1,
      recipient: fixture.rungOne,
    });
    if (!drafted.ok) throw new Error(drafted.message);
    expect(drafted.message.status).toBe("proposed");
    expect(drafted.message.sendAttemptedAt).toBeNull();

    await hardBounce(fixture);

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "manual_review",
      currentStep: 0,
    });
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("accepted");
  });

  it("refuses to advance past the rung ceiling and says an address remains", async () => {
    await setLadderSettings({ addressLadderMaxRungs: 1 });
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    // Parked, not ended: the ceiling is a number the operator chose and can
    // raise, and a prospect lost to it could never be got back.
    expect(enrollment).toMatchObject({
      state: "manual_review",
      stopReason: null,
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    expect(contact?.emailResolutionReason).toBe("ladder_limit_reached");
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
    await setLadderSettings({});
  });

  it("does not advance while the feature is switched off", async () => {
    await setLadderSettings({ addressLadderEnabled: false });
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    // No reason on the address. The prospect is finished, exactly as they were
    // before the feature existed, and switching it back on revives nobody — so
    // a sentence inviting the operator to raise a bound would be a wrong
    // instruction rather than an unhelpful one.
    expect(contact?.emailResolutionReason).not.toBe("ladder_limit_reached");
    await setLadderSettings({});
  });

  it("stops advancing when the explicit-failure rate trips the circuit breaker", async () => {
    await setLadderSettings({});
    // A company whose one send is already a proven failure, so the installation
    // carries a real explicit-failure population before the breaker is asked.
    const earlier = await ladderFixture();
    await hardBounce(earlier);

    await setLadderSettings({
      addressLadderFailureRateMinimumSends: 2,
      addressLadderFailureRatePercent: 50,
    });
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    // The breaker stops the feature; it does not condemn this prospect. Closing
    // it again and resolving the company promotes the rung that is still there.
    expect(enrollment).toMatchObject({
      state: "manual_review",
      stopReason: null,
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    expect(contact?.emailResolutionReason).toBe("ladder_limit_reached");
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
    await setLadderSettings({});
  });

  it("does not advance a contact whose employment moved since the dead message", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await db
      .update(schema.contacts)
      .set({ employmentVersion: 2 })
      .where(eq(schema.contacts.id, fixture.contact.id));
    await hardBounce(fixture);
    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment.state).toBe("bounced");
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
  });

  /**
   * A bound the operator sets is a pacing device, not a verdict on the prospect.
   *
   * The per-company daily cap exists so a wrong convention cannot spend a day's
   * reputation in an hour. Ending the enrollment when it bites would make it
   * something else entirely: the third bounce of the day at one company would
   * lose that person as permanently as a ladder with nothing left on it, and
   * raising the bound afterwards would not bring them back.
   */
  it("parks rather than ends a prospect a raisable bound stopped", async () => {
    await setLadderSettings({ addressLadderMaxAdvancesPerAccountPerDay: 0 });
    const fixture = await ladderFixture();
    await hardBounce(fixture);

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "manual_review",
      currentStep: 0,
      stopReason: null,
      nextActionAt: null,
      nextActionToken: null,
    });
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    expect(contact?.emailResolutionReason).toBe("ladder_limit_reached");
    // The address that remains is still there to be reached.
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
    await setLadderSettings({});
  });

  /**
   * And the way back is the one the operator already knows: resolving the
   * company promotes the surviving rung, because a dead address is never
   * re-accepted and the next one is simply the best that is left.
   */
  it("lets an ordinary resolution promote the surviving rung of a parked prospect", async () => {
    await setLadderSettings({ addressLadderMaxRungs: 1 });
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    expect((await enrollmentRow(fixture.enrollmentId)).state).toBe(
      "manual_review",
    );

    await setLadderSettings({ addressLadderMaxRungs: 3 });
    const resolved = await fixture.resolve(fixture.contact.id);
    expect(resolved).toMatchObject({ ok: true, status: "resolved" });

    const rows = await candidates(fixture.contact.id);
    expect(rows.find((row) => row.status === "accepted")?.normalizedEmail).toBe(
      fixture.rungTwo,
    );
    // The dead address is never revived by fresh evidence about its convention.
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungOne)?.status,
    ).toBe("rejected");
    // And the message can then be written to the new address at the same step.
    const regenerated = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 0,
      recipient: fixture.rungTwo,
    });
    expect(regenerated).toMatchObject({ ok: true, disposition: "created" });
    await setLadderSettings({});
  });

  /**
   * The refusal that is not a bound: this person may be holding an earlier
   * message, so nothing about raising a setting changes the answer, and the
   * sentence they read must not invite them to try.
   */
  it("names an unconfirmed earlier send as its own outcome, not as a bound", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ steps: 3 });
    const followUp = await generateOutreachProposal(db, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 1,
      recipient: fixture.rungOne,
    });
    if (!followUp.ok) throw new Error(followUp.message);
    await awaitingReview(fixture.enrollmentId);
    const review = await reviewMessage(db, {
      messageId: followUp.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!review.ok) throw new Error(review.message);
    const sent = await sendApprovedMessage(
      db,
      fixture.provider,
      { messageId: followUp.message.id },
      { clock: () => new Date("2026-08-19T12:00:00.000Z") },
    );
    if (!sent.ok) throw new Error(sent.code);
    sequence += 1;
    await ingestInboundMessage(db, classifier, {
      mailboxId: fixture.mailbox.id,
      providerMessageId: `dsn-outstanding-reason-${sequence}`,
      outreachId: sent.message.outreachId ?? undefined,
      sender: "postmaster@example.net",
      recipient: fixture.mailbox.email,
      bouncedRecipient: fixture.rungOne,
      subject: "Delivery status notification",
      body: "Recipient address rejected: user unknown",
      bounceKind: "hard" as const,
      receivedAt: new Date("2026-08-19T12:30:00.000Z"),
    });

    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, fixture.contact.id))
      .limit(1);
    expect(contact?.emailResolutionReason).toBe(
      "ladder_earlier_send_unconfirmed",
    );
    expect((await enrollmentRow(fixture.enrollmentId)).state).toBe("bounced");
  });

  it("marks a rung a suppression is blocking rather than hiding it", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ send: false });
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: fixture.rungTwo,
      reason: "hard_bounce",
    });
    const blocked = await readBlockedRungs(db, fixture.contact.id);
    expect(blocked).toContain(fixture.rungTwo);
    expect(blocked).not.toContain(fixture.rungOne);
  });

  /**
   * A reconciliation that lands after the bounce must not undo the advance.
   *
   * The provider really did accept the message, and the recipient really does
   * not exist. Recording it as sent is right; stepping the sequence past a step
   * nothing was delivered at is not — that would schedule a follow-up to a dead
   * thread and quietly consume the step the ladder had just given back.
   */
  it("does not progress the sequence when a dead message is later confirmed sent", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ steps: 3 });
    await hardBounce(fixture);
    const advanced = await enrollmentRow(fixture.enrollmentId);
    expect(advanced).toMatchObject({ state: "manual_review", currentStep: 0 });

    // The recovery path finds the dead message still claimable and reconciles it
    // as sent, exactly as an interrupted submit would.
    await db
      .update(schema.messages)
      .set({
        status: "delivery_uncertain",
        sendAttemptToken: null,
        sendClaimedAt: null,
      })
      .where(eq(schema.messages.id, fixture.message!.id));
    const reconciled = await sendApprovedMessage(
      db,
      fixture.provider,
      { messageId: fixture.message!.id },
      { clock: () => new Date("2026-08-18T11:00:00.000Z") },
    );
    expect(reconciled.ok).toBe(true);

    const after = await enrollmentRow(fixture.enrollmentId);
    expect(after).toMatchObject({
      state: "manual_review",
      currentStep: 0,
      nextActionAt: null,
      nextActionToken: null,
    });
    // And it never becomes the message follow-up timing counts from.
    expect(after.lastMessageAt).toBeNull();
  });

  /**
   * Resolution reads the contact's dead and suppressed addresses before it does
   * its slow work, and a bounce arriving in that window commits its own
   * transaction — the ladder is not fenced by the resolution claim, and nothing
   * about a death changes the account, domain or employment version the claim
   * checks. The persisting transaction has to be the authority, or a resolution
   * that started a second earlier writes `accepted` back onto an address
   * delivery has just proven does not exist.
   *
   * The DNS resolver stands in for the concurrent commit because it is awaited
   * after the snapshot is taken and before the transaction opens, which is
   * exactly the window.
   */
  it("never re-accepts an address that died while it was resolving", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ send: false });
    const before = await candidates(fixture.contact.id);
    expect(
      before.find((row) => row.status === "accepted")?.normalizedEmail,
    ).toBe(fixture.rungOne);

    const killDuringResolution = {
      resolve: async () => {
        await db
          .update(schema.emailCandidates)
          .set({ deadAt: new Date(), status: "rejected" })
          .where(
            and(
              eq(schema.emailCandidates.contactId, fixture.contact.id),
              eq(schema.emailCandidates.normalizedEmail, fixture.rungOne),
            ),
          );
        return {
          hasMx: true,
          records: [{ exchange: "mx.ladder.example", priority: 10 }],
        };
      },
    };
    const outcome = await resolveContactEmail(
      db,
      killDuringResolution,
      null,
      { contactId: fixture.contact.id },
      {
        publicEvidenceProvider: new StaticPublicEmailEvidenceProvider(
          fixture.publicSamples,
        ),
      },
    );
    expect(outcome).toMatchObject({ ok: true });

    const after = await candidates(fixture.contact.id);
    const dead = after.find((row) => row.normalizedEmail === fixture.rungOne);
    expect(dead?.deadAt).not.toBeNull();
    expect(dead?.status).toBe("rejected");
    // Whatever it accepted, it was not the address that died.
    expect(
      after.find((row) => row.status === "accepted")?.normalizedEmail,
    ).not.toBe(fixture.rungOne);
  });

  /**
   * A downgrade has to take the old address with it. `prepareCommand` reads the
   * accepted candidate directly to address a queued message, so an `accepted`
   * row left behind by a resolution that has since concluded "no usable address"
   * spends an agent turn drafting a message the send policy will refuse — the
   * silent refusal at send time this design exists to remove.
   */
  it("demotes an accepted address a later resolution can no longer use", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ send: false });
    expect(
      (await candidates(fixture.contact.id)).find(
        (row) => row.status === "accepted",
      ),
    ).toBeDefined();

    await db.insert(schema.suppressionEntries).values({
      scope: "domain",
      normalizedValue: fixture.domain,
      reason: "manual",
    });
    const outcome = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: fixture.contact.id },
      {
        publicEvidenceProvider: new StaticPublicEmailEvidenceProvider(
          fixture.publicSamples,
        ),
      },
    );
    expect(outcome).toMatchObject({
      ok: true,
      status: "manual_review",
      reason: "address_suppressed",
    });
    const after = await candidates(fixture.contact.id);
    expect(after.filter((row) => row.status === "accepted")).toEqual([]);
  });

  /**
   * The task the queue actually runs is `generateWithPersonalization`, which
   * short-circuits to the plain generator when the step already has a message so
   * it does not spend an agent turn to be told so. That shortcut has to apply the
   * same rule as the generator it defers to — a dead message is not this step's
   * message — or an advance on a personalized step strands the prospect: the turn
   * is skipped, interpolation then fails on a field nobody wrote, and the queue
   * abandons a command no manual retry can get past either.
   */
  it("still asks for the sentences a personalized step declares after an advance", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ personalized: true });
    await hardBounce(fixture);

    // The shipped mock agent, so the provenance postconditions the real path
    // enforces are the ones this exercises.
    let turns = 0;
    const fixtureAgent = new MockPersonalizationAgent({
      fields: [
        {
          name: "personalized_opening",
          value: "Noticed your new depot",
          confidence: 0.9,
          sourceUrls: [`https://${fixture.domain}/news`],
        },
      ],
      sources: [
        {
          url: `https://${fixture.domain}/news`,
          title: "Depot expansion",
          supports: ["personalization"],
          retrievedAt: null,
        },
      ],
    });
    const agent = {
      name: fixtureAgent.name,
      model: fixtureAgent.model,
      promptVersion: fixtureAgent.promptVersion,
      schemaVersion: fixtureAgent.schemaVersion,
      personalize: async (
        input: Parameters<typeof fixtureAgent.personalize>[0],
      ) => {
        turns += 1;
        return fixtureAgent.personalize(input);
      },
    };
    const generated = await generateWithPersonalization(db, agent, {
      enrollmentId: fixture.enrollmentId,
      stepIndex: 0,
      recipient: fixture.rungTwo,
    });

    if (!generated.ok) throw new Error(JSON.stringify(generated));
    expect(generated).toMatchObject({ ok: true, disposition: "created" });
    expect(turns).toBe(1);
    if (!generated.ok) throw new Error("generation failed");
    expect(generated.message.recipient).toBe(fixture.rungTwo);
    expect(generated.message.body).toContain("Noticed your new depot");
  });

  /**
   * A convention belongs to the domain it was tried on. A contact who changes
   * employer keeps their old candidate rows while `contacts.account_id` moves, so
   * attributing the failure through the contact carried an old employer's bounce
   * into the new company's record — where it could demote a convention that
   * company never ran and re-rank colleagues with nothing to do with it.
   */
  it("attributes a failure to the domain it happened on, not to a later employer", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    const elsewhere = await createOrGetAccount(db, {
      name: `Later Employer ${sequence}`,
      domain: `later-employer-${sequence}.example`,
    });
    if (!elsewhere.ok) throw new Error("account fixture failed");

    await hardBounce(fixture);
    // The contact moves after the bounce, exactly as a validated employment move
    // rewrites the column in place.
    await db
      .update(schema.contacts)
      .set({ accountId: elsewhere.account.id })
      .where(eq(schema.contacts.id, fixture.contact.id));

    const atOldDomain = await readConventionOutcomes(db, {
      domain: fixture.domain,
      minimumPeople: 2,
      failureSharePercent: 50,
    });
    expect(
      atOldDomain.find((row) => row.pattern === "first.last")?.peopleProvenDead,
    ).toBe(1);
    const atNewDomain = await readConventionOutcomes(db, {
      domain: elsewhere.account.domain,
      minimumPeople: 2,
      failureSharePercent: 50,
    });
    expect(atNewDomain).toEqual([]);
  });

  /**
   * `inboundHoldCount` counts every inbound record holding an enrollment. The
   * ladder used to zero all five hold columns, which is right only when it is the
   * sole holder: another record still in flight would later restore from a wiped
   * snapshot and land the enrollment in `waiting` with no `next_action_at`, where
   * nothing would ever look at it again.
   */
  it("does not destroy another inbound record's hold when it takes over", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    // A second record is already holding this enrollment with a real snapshot.
    await db
      .update(schema.enrollments)
      .set({
        inboundHoldCount: 1,
        inboundHoldAt: new Date("2026-08-18T10:20:00.000Z"),
        inboundHoldPreviousState: "waiting",
        inboundHoldPreviousNextActionAt: new Date("2026-08-25T10:00:00.000Z"),
        inboundHoldPreviousNextActionToken: `other-hold-${sequence}`,
      })
      .where(eq(schema.enrollments.id, fixture.enrollmentId));

    await hardBounce(fixture);

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment.state).toBe("manual_review");
    // The other record's hold survives, and what it would restore is now the
    // state the ladder decided rather than a stale schedule.
    expect(enrollment.inboundHoldCount).toBe(1);
    expect(enrollment.inboundHoldPreviousState).toBe("manual_review");
    expect(enrollment.inboundHoldPreviousNextActionAt).toBeNull();
    expect(enrollment.inboundHoldPreviousNextActionToken).toBeNull();
  });

  it("does not resurrect a sequence somebody ended", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await db
      .update(schema.enrollments)
      .set({
        state: "stopped",
        stopReason: "manual_stop",
        stoppedAt: new Date("2026-08-18T10:15:00.000Z"),
      })
      .where(eq(schema.enrollments.id, fixture.enrollmentId));

    await hardBounce(fixture);

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "stopped",
      stopReason: "manual_stop",
    });
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("candidate");
    // The address is still dead and still suppressed: only the advance was
    // refused, not the two facts the bounce established.
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungOne)?.deadAt,
    ).not.toBeNull();
  });

  /**
   * A one-step campaign completes the moment its message is sent, so the only
   * terminal state a ladder must be able to advance from is that one — the
   * sequence was not ended by a decision, it ran out of steps, and the bounce is
   * the proof that its one message reached nobody.
   */
  it("advances a sequence that completed only because it ran out of steps", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture({ steps: 1 });
    const before = await enrollmentRow(fixture.enrollmentId);
    expect(before).toMatchObject({
      state: "completed",
      stopReason: "sequence_complete",
    });

    await hardBounce(fixture);

    const enrollment = await enrollmentRow(fixture.enrollmentId);
    expect(enrollment).toMatchObject({
      state: "manual_review",
      currentStep: 0,
      stopReason: null,
    });
    const rows = await candidates(fixture.contact.id);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungTwo)?.status,
    ).toBe("accepted");
  });

  it("leaves a soft bounce entirely alone", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    sequence += 1;
    const soft = await ingestInboundMessage(db, classifier, {
      mailboxId: fixture.mailbox.id,
      providerMessageId: `dsn-soft-${sequence}`,
      outreachId: fixture.message?.outreachId ?? undefined,
      sender: "postmaster@example.net",
      recipient: fixture.mailbox.email,
      bouncedRecipient: fixture.rungOne,
      subject: "Delivery delayed",
      body: "Mailbox full",
      bounceKind: "soft" as const,
      receivedAt: bouncedAt,
    });
    expect(soft).toMatchObject({ ok: true, disposition: "processed" });
    const rows = await candidates(fixture.contact.id);
    expect(rows.every((row) => row.deadAt === null)).toBe(true);
    expect(
      rows.find((row) => row.normalizedEmail === fixture.rungOne)?.status,
    ).toBe("accepted");
    const [message] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message!.id))
      .limit(1);
    expect(message?.addressDeadAt).toBeNull();
  });

  it("treats a step whose only message is dead as having none", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    // The advance clears the schedule, so re-arm one exactly as a follow-up
    // would and confirm the dead message does not make the step look done.
    await db
      .update(schema.enrollments)
      .set({
        state: "ready_for_review",
        nextActionAt: new Date("2026-08-18T11:00:00.000Z"),
        nextActionToken: `ladder-due-${sequence}`,
      })
      .where(eq(schema.enrollments.id, fixture.enrollmentId));
    const due = await findDueEnrollments(db, {
      now: new Date("2026-08-18T12:00:00.000Z"),
    });
    expect(due.map((row) => row.enrollmentId)).toContain(fixture.enrollmentId);
  });

  it("demotes a convention two people proved dead and re-ranks colleagues nobody has written to", async () => {
    await setLadderSettings({ addressLadderMaxAdvancesPerAccountPerDay: 10 });
    const first = await ladderFixture({ extraContacts: 2 });
    await hardBounce(first);

    // A second person at the same company, on the same convention, also dies.
    const colleague = first.colleagues[0]!;
    const enrollment = await enrollContact(db, {
      campaignId: first.campaign.id,
      campaignVersionId: first.version.id,
      contactId: colleague.id,
      mailboxId: first.mailbox.id,
    });
    if (!enrollment.ok) throw new Error(enrollment.message);
    const colleagueRows0 = await candidates(colleague.id);
    const colleagueRungOne = colleagueRows0.find(
      (row) => row.status === "accepted",
    )!.normalizedEmail;
    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: colleagueRungOne,
    });
    if (!proposal.ok) throw new Error(proposal.message);
    const review = await reviewMessage(db, {
      messageId: proposal.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!review.ok) throw new Error(review.message);
    const sent = await sendApprovedMessage(
      db,
      first.provider,
      { messageId: proposal.message.id },
      { clock: () => new Date("2026-08-18T14:00:00.000Z") },
    );
    if (!sent.ok) throw new Error(sent.code);
    const secondBounce = await ingestInboundMessage(db, classifier, {
      mailboxId: first.mailbox.id,
      providerMessageId: `dsn-demote-${sequence}`,
      outreachId: sent.message.outreachId ?? undefined,
      sender: "postmaster@example.net",
      recipient: first.mailbox.email,
      bouncedRecipient: colleagueRungOne,
      subject: "Delivery status notification",
      body: "Recipient address rejected: user unknown",
      bounceKind: "hard" as const,
      receivedAt: new Date("2026-08-18T14:30:00.000Z"),
    });
    expect(secondBounce).toMatchObject({ ok: true, disposition: "processed" });

    const outcomes = await readConventionOutcomes(db, {
      domain: first.domain,
      minimumPeople: 2,
      failureSharePercent: 50,
    });
    const demoted = outcomes.find((row) => row.pattern === "first.last");
    expect(demoted).toMatchObject({
      peopleAttempted: 2,
      peopleProvenDead: 2,
      peopleNoSignal: 0,
      demoted: true,
    });

    // The colleague nobody has written to is moved off the discredited
    // convention rather than left to attempt a form just observed to fail.
    const untouched = first.colleagues[1]!;
    const rows = await candidates(untouched.id);
    const accepted = rows.find((row) => row.status === "accepted");
    expect(accepted?.pattern).toBe("f.last");
    expect(accepted?.advancedAt).toBeNull();
    // Its confidence is untouched: demotion reorders, it never rescores.
    const stillBest = rows.find((row) => row.pattern === "first.last");
    expect(stillBest?.confidence).toBe("0.970");
  });

  it("keeps a demoted address on a contact whose message has already been written", async () => {
    await setLadderSettings({ addressLadderMaxAdvancesPerAccountPerDay: 10 });
    const fixture = await ladderFixture({ extraContacts: 1 });
    const colleague = fixture.colleagues[0]!;
    const enrollment = await enrollContact(db, {
      campaignId: fixture.campaign.id,
      campaignVersionId: fixture.version.id,
      contactId: colleague.id,
      mailboxId: fixture.mailbox.id,
    });
    if (!enrollment.ok) throw new Error(enrollment.message);
    const colleagueRows = await candidates(colleague.id);
    const colleagueAccepted = colleagueRows.find(
      (row) => row.status === "accepted",
    );
    if (!colleagueAccepted) throw new Error("colleague has no address");
    // A message exists for them, so their address is pinned by it.
    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: colleagueAccepted.normalizedEmail,
    });
    if (!proposal.ok) throw new Error(proposal.message);

    // Force the demotion of `first.last` at this company by hand: two distinct
    // people, both proven dead, which is the rule's own floor.
    await db
      .update(schema.emailCandidates)
      .set({ deadAt: new Date("2026-08-18T09:00:00.000Z") })
      .where(
        and(
          eq(schema.emailCandidates.contactId, fixture.contact.id),
          eq(schema.emailCandidates.pattern, "first.last"),
        ),
      );
    await hardBounce(fixture);

    const after = await candidates(colleague.id);
    expect(
      after.find((row) => row.status === "accepted")?.normalizedEmail,
    ).toBe(colleagueAccepted.normalizedEmail);
  });

  it("reports the pipeline's ladder position and the per-convention failure split", async () => {
    await setLadderSettings({});
    const fixture = await ladderFixture();
    await hardBounce(fixture);
    const metrics = await readAddressLadderMetrics(db, {
      now: new Date("2026-08-18T18:00:00.000Z"),
    });
    expect(metrics.advanced).toBeGreaterThanOrEqual(1);
    expect(metrics.sendsAttempted).toBeGreaterThanOrEqual(1);
    expect(metrics.sendsProvenDead).toBeGreaterThanOrEqual(1);
    expect(metrics.sendsNoSignal).toBe(
      metrics.sendsAttempted -
        metrics.sendsProvenDead -
        metrics.sendsAcknowledged,
    );
    const outcomes = await readConventionOutcomes(db, {
      minimumPeople: 2,
      failureSharePercent: 50,
    });
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(outcome.peopleAttempted).toBeGreaterThanOrEqual(
        outcome.peopleProvenDead,
      );
    }
  });

  /**
   * The defects a second review of this feature found, each pinned by the
   * scenario that produced it.
   *
   * Grouped rather than scattered through the suite above: every one of them was
   * a path that looked correct in isolation and only went wrong where two rules
   * met, and keeping the scenarios next to each other is what makes that visible.
   */
  describe("address ladder — second-review defects", () => {
    it("refuses to accept an address delivery has proven does not exist", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      await hardBounce(fixture);

      const revived = await acceptManualEmail(db, {
        contactId: fixture.contact.id,
        email: fixture.rungOne,
        actor: "operator",
      });
      expect(revived).toMatchObject({ ok: false, code: "ADDRESS_DEAD" });
      const rows = await candidates(fixture.contact.id);
      const dead = rows.find((row) => row.normalizedEmail === fixture.rungOne);
      expect(dead?.status).toBe("rejected");
      expect(dead?.deadAt).not.toBeNull();
    });

    it("refuses to accept an address the suppression list blocks", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture({ send: false });
      await db.insert(schema.suppressionEntries).values({
        scope: "email",
        normalizedValue: fixture.rungTwo,
        reason: "hard_bounce",
      });

      const blocked = await acceptManualEmail(db, {
        contactId: fixture.contact.id,
        email: fixture.rungTwo,
        actor: "operator",
      });
      expect(blocked).toMatchObject({ ok: false, code: "ADDRESS_SUPPRESSED" });
    });

    it("gives a hand-accepted address its own rung rather than a second rung one", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture({ send: false });
      const accepted = await acceptManualEmail(db, {
        contactId: fixture.contact.id,
        email: `alice.r${sequence}.direct@${fixture.domain}`,
        actor: "operator",
      });
      expect(accepted).toMatchObject({ ok: true });

      const rows = await candidates(fixture.contact.id);
      const ranks = rows.map((row) => row.ladderRank);
      expect(new Set(ranks).size).toBe(ranks.length);
      // Corroborated by a human outranks anything the samples produced.
      expect(rows[0]?.status).toBe("accepted");
      expect(rows[0]?.source).toBe("operator_manual");
    });

    it("keeps a convention demoted once its record has discredited it", async () => {
      await setLadderSettings({
        addressLadderDemotionMinimumPeople: 2,
        addressLadderDemotionFailureSharePercent: 50,
        addressLadderMaxAdvancesPerAccountPerDay: 10,
      });
      const fixture = await ladderFixture({ send: false, extraContacts: 5 });
      const [first, second, ...rest] = fixture.colleagues;
      if (!first || !second) throw new Error("fixture needs colleagues");
      const rungOneOf = async (contactId: string) => {
        const rows = await candidates(contactId);
        const row = rows.find(
          (candidate) => candidate.pattern === "first.last",
        );
        if (!row) throw new Error("no first.last rung");
        return row;
      };
      // Two people proven dead out of two attempted: the rule's own floor.
      for (const person of [first, second]) {
        const row = await rungOneOf(person.id);
        await db
          .update(schema.emailCandidates)
          .set({
            deadAt: new Date("2026-08-18T09:00:00.000Z"),
            firstAttemptedAt: new Date("2026-08-18T08:00:00.000Z"),
          })
          .where(eq(schema.emailCandidates.id, row.id));
      }
      const outcomes = await readConventionOutcomes(db, {
        domain: fixture.domain,
        minimumPeople: 2,
        failureSharePercent: 50,
      });
      expect(
        outcomes.find((row) => row.pattern === "first.last"),
      ).toMatchObject({
        demoted: true,
        demotedDomains: [fixture.domain],
      });

      // A death latches the verdict — this is the only path that writes it.
      await db
        .update(schema.emailCandidates)
        .set({ deadAt: null, deadMessageId: null })
        .where(eq(schema.emailCandidates.id, (await rungOneOf(second.id)).id));
      await db.insert(schema.conventionDemotions).values({
        domain: fixture.domain,
        pattern: "first.last",
        demotedAt: new Date("2026-08-18T09:00:00.000Z"),
        peopleProvenDead: 2,
        peopleAttempted: 2,
      });
      // Four more people written to, none of whom reported anything back. Under a
      // live ratio this is one dead in five and the convention comes back.
      for (const person of [second, ...rest]) {
        const row = await rungOneOf(person.id);
        await db
          .update(schema.emailCandidates)
          .set({ firstAttemptedAt: new Date("2026-08-18T11:00:00.000Z") })
          .where(eq(schema.emailCandidates.id, row.id));
      }
      const later = await readConventionOutcomes(db, {
        domain: fixture.domain,
        minimumPeople: 2,
        failureSharePercent: 50,
      });
      const diluted = later.find((row) => row.pattern === "first.last");
      expect(diluted?.peopleProvenDead).toBe(1);
      expect(diluted?.peopleAttempted).toBeGreaterThanOrEqual(5);
      // Silence never restores a convention: that would be delivery evidence
      // vouching for an address, which this product never allows.
      expect(diluted?.demoted).toBe(true);
    });

    it("reports a demotion against the company it happened at, not the whole installation", async () => {
      await setLadderSettings({});
      const guilty = await ladderFixture({ send: false, extraContacts: 1 });
      const innocent = await ladderFixture({ send: false, extraContacts: 1 });
      for (const person of [guilty.contact, guilty.colleagues[0]!]) {
        const rows = await candidates(person.id);
        const row = rows.find(
          (candidate) => candidate.pattern === "first.last",
        );
        if (!row) throw new Error("no first.last rung");
        await db
          .update(schema.emailCandidates)
          .set({
            deadAt: new Date("2026-08-18T09:00:00.000Z"),
            firstAttemptedAt: new Date("2026-08-18T08:00:00.000Z"),
          })
          .where(eq(schema.emailCandidates.id, row.id));
      }
      const everywhere = await readConventionOutcomes(db, {
        minimumPeople: 2,
        failureSharePercent: 50,
      });
      const pattern = everywhere.find((row) => row.pattern === "first.last");
      expect(pattern?.demotedDomains).toContain(guilty.domain);
      expect(pattern?.demotedDomains).not.toContain(innocent.domain);
      expect(pattern?.attemptedDomains).toBeGreaterThanOrEqual(1);
    });

    it("counts a send a human answered as reached, never as no signal", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      if (!fixture.message) throw new Error("nothing was sent");
      const before = await readAddressLadderMetrics(db, {
        now: new Date("2026-08-18T18:00:00.000Z"),
      });
      await ingestInboundMessage(db, classifier, {
        mailboxId: fixture.mailbox.id,
        providerMessageId: `reply-ack-${sequence}`,
        outreachId: fixture.message.outreachId ?? undefined,
        inReplyTo: `<${fixture.message.outreachId}@mock.hyperoutreach>`,
        sender: fixture.rungOne,
        recipient: fixture.mailbox.email,
        subject: "Re: Step 0 Alice",
        body: "Merci, je regarde cela cette semaine.",
        receivedAt: new Date("2026-08-18T12:00:00.000Z"),
      });
      const after = await readAddressLadderMetrics(db, {
        now: new Date("2026-08-18T18:00:00.000Z"),
      });
      expect(after.sendsAcknowledged).toBe(before.sendsAcknowledged + 1);
      expect(after.sendsNoSignal).toBe(before.sendsNoSignal - 1);
    });

    it("says nothing about the address when the sequence ended for its own reasons", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      await db
        .update(schema.enrollments)
        .set({
          state: "opted_out",
          stopReason: "unsubscribe",
          stoppedAt: new Date("2026-08-18T10:20:00.000Z"),
        })
        .where(eq(schema.enrollments.id, fixture.enrollmentId));
      await hardBounce(fixture);

      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, fixture.contact.id));
      // A bound the operator could raise would have changed nothing here.
      expect(contact?.emailResolutionReason).not.toBe("ladder_limit_reached");
    });

    it("shows a prospect a bound parked, and hides one whose message is on its way", async () => {
      await setLadderSettings({ addressLadderMaxRungs: 1 });
      const parkedByBound = await ladderFixture();
      // The fixture writes its message directly rather than through the queue,
      // so the request enrolment made is still sitting there. Retiring it is
      // what the maintenance cycle does the moment it runs.
      const drainQueue = async () =>
        db
          .update(schema.operatorCommands)
          .set({ status: "succeeded" })
          .where(eq(schema.operatorCommands.task, "generate-message"));
      await drainQueue();
      await hardBounce(parkedByBound);

      await setLadderSettings({ addressLadderMaxRungs: 3 });
      const advanced = await ladderFixture();
      await drainQueue();
      await hardBounce(advanced);

      const parked = await readParkedEnrollments(db);
      const ids = parked.map((row) => row.enrollmentId);
      // A bound the operator can raise stopped this one, and nothing else in the
      // product would ever mention it again.
      expect(ids).toContain(parkedByBound.enrollmentId);
      // This one has a generation queued: it is in flight, not parked.
      expect(ids).not.toContain(advanced.enrollmentId);
      const row = parked.find(
        (candidate) => candidate.enrollmentId === parkedByBound.enrollmentId,
      );
      expect(row?.contactName).toBe(parkedByBound.contact.fullName);
      expect(row?.resolutionReason).toBe("ladder_limit_reached");
    });

    it("never counts one send as both proven dead and reached", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      if (!fixture.message) throw new Error("nothing was sent");
      const before = await readAddressLadderMetrics(db, {
        now: new Date("2026-08-18T18:00:00.000Z"),
      });
      await hardBounce(fixture);
      // An autoresponder arriving after the bounce, threaded to the same
      // message: real, and no evidence at all that the address exists.
      await ingestInboundMessage(db, classifier, {
        mailboxId: fixture.mailbox.id,
        providerMessageId: `auto-after-death-${sequence}`,
        outreachId: fixture.message.outreachId ?? undefined,
        inReplyTo: `<${fixture.message.outreachId}@mock.hyperoutreach>`,
        sender: fixture.rungOne,
        recipient: fixture.mailbox.email,
        subject: "Automatic reply",
        body: "I am away from the office until Monday.",
        receivedAt: new Date("2026-08-18T11:00:00.000Z"),
      });

      const metrics = await readAddressLadderMetrics(db, {
        now: new Date("2026-08-18T18:00:00.000Z"),
      });
      // Counting this one message in two buckets subtracted it twice from
      // "nothing came back", and the clamp then hid the inconsistency. The
      // arithmetic identity alone cannot catch that — `sendsNoSignal` is
      // derived from the other two, so it absorbs any overlap silently. What
      // has to be asserted is the count itself.
      expect(metrics.sendsAcknowledged).toBe(before.sendsAcknowledged);
      expect(metrics.sendsProvenDead).toBe(before.sendsProvenDead + 1);
      expect(
        metrics.sendsProvenDead +
          metrics.sendsAcknowledged +
          metrics.sendsNoSignal,
      ).toBe(metrics.sendsAttempted);
    });

    it("keeps a former employer's address off the ladder of the company that bounced", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      const elsewhere = await createOrGetAccount(db, {
        name: `Former ${sequence}`,
        domain: `former-${sequence}.example`,
      });
      if (!elsewhere.ok) throw new Error(elsewhere.message);
      const formerDomain = elsewhere.account.domain!;
      // An untried address from a company the contact used to work at, ranked
      // ahead of everything by an accident of ordering.
      await db.insert(schema.emailCandidates).values({
        contactId: fixture.contact.id,
        email: `alice.former@${formerDomain}`,
        normalizedEmail: `alice.former@${formerDomain}`,
        domain: formerDomain,
        pattern: "first.last",
        confidence: "0.990",
        source: "public_pattern",
        status: "candidate",
        ladderRank: 1,
      });

      await hardBounce(fixture);

      const rows = await candidates(fixture.contact.id);
      const accepted = rows.find((row) => row.status === "accepted");
      // The next rung is this company's, never the one the prospect left.
      expect(accepted?.domain).toBe(fixture.domain);
      expect(accepted?.normalizedEmail).toBe(fixture.rungTwo);
    });

    it("leaves the address column of a contact who has moved alone", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      const elsewhere = await createOrGetAccount(db, {
        name: `Moved ${sequence}`,
        domain: `moved-${sequence}.example`,
      });
      if (!elsewhere.ok) throw new Error(elsewhere.message);
      await db
        .update(schema.contacts)
        .set({
          accountId: elsewhere.account.id,
          employmentVersion: fixture.contact.employmentVersion + 1,
          emailResolutionStatus: "resolved",
          emailResolutionReason: null,
        })
        .where(eq(schema.contacts.id, fixture.contact.id));

      await hardBounce(fixture);

      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.id, fixture.contact.id));
      // A late report about the company they left has no standing to
      // un-resolve the address their current one established.
      expect(contact?.emailResolutionStatus).toBe("resolved");
      expect(contact?.emailResolutionReason).toBeNull();
    });

    it("does not call an enrollment holding an unclassified reply parked", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      // Retire the request enrolment made, so nothing else keeps this
      // enrollment off the list and the hold is the only discriminator left.
      await db
        .update(schema.operatorCommands)
        .set({ status: "succeeded" })
        .where(eq(schema.operatorCommands.task, "generate-message"));
      // The shape an inbound hold leaves behind: manual review, no schedule —
      // which the maintenance cycle releases on its own, with no operator.
      await db
        .update(schema.enrollments)
        .set({
          state: "manual_review",
          nextActionAt: null,
          nextActionToken: null,
          inboundHoldCount: 1,
          inboundHoldAt: new Date("2026-08-18T11:00:00.000Z"),
        })
        .where(eq(schema.enrollments.id, fixture.enrollmentId));

      const held = await readParkedEnrollments(db);
      expect(held.map((row) => row.enrollmentId)).not.toContain(
        fixture.enrollmentId,
      );
      // Releasing the hold is what makes it genuinely parked, which proves the
      // rest of the predicate was already satisfied and the count is what
      // decided it.
      await db
        .update(schema.enrollments)
        .set({ inboundHoldCount: 0 })
        .where(eq(schema.enrollments.id, fixture.enrollmentId));
      const released = await readParkedEnrollments(db);
      expect(released.map((row) => row.enrollmentId)).toContain(
        fixture.enrollmentId,
      );
    });

    it("refuses a hand-accepted address the suppression list blocks mid-write", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture({ send: false });
      // The row exists and is not dead, so only the write's own condition can
      // refuse it — which is the shape of the race: the suppression is written
      // by a transaction that takes none of this path's locks.
      const rows = await candidates(fixture.contact.id);
      const target = rows.find(
        (row) => row.normalizedEmail === fixture.rungTwo,
      );
      if (!target) throw new Error("fixture has no second rung");
      await db.insert(schema.suppressionEntries).values({
        scope: "email",
        normalizedValue: fixture.rungTwo,
        reason: "hard_bounce",
      });

      const refused = await acceptManualEmail(db, {
        contactId: fixture.contact.id,
        email: fixture.rungTwo,
        actor: "operator",
      });
      expect(refused).toMatchObject({ ok: false, code: "ADDRESS_SUPPRESSED" });
      const after = await candidates(fixture.contact.id);
      // Accepted-and-suppressed reads as resolved on the prospect list while
      // every send is refused. Nothing may commit it.
      expect(after.find((row) => row.id === target.id)?.status).not.toBe(
        "accepted",
      );
    });

    it("restores a convention an operator says the record misread, and only on their terms", async () => {
      await setLadderSettings({
        addressLadderDemotionMinimumPeople: 2,
        addressLadderDemotionFailureSharePercent: 50,
      });
      const fixture = await ladderFixture({ send: false, extraContacts: 3 });
      const rungOneOf = async (contactId: string) => {
        const rows = await candidates(contactId);
        const row = rows.find(
          (candidate) => candidate.pattern === "first.last",
        );
        if (!row) throw new Error("no first.last rung");
        return row;
      };
      const kill = async (contactId: string, at: Date) => {
        const row = await rungOneOf(contactId);
        await db
          .update(schema.emailCandidates)
          .set({ deadAt: at, firstAttemptedAt: at })
          .where(eq(schema.emailCandidates.id, row.id));
      };
      const demotedNow = async () => {
        const outcomes = await readConventionOutcomes(db, {
          domain: fixture.domain,
          minimumPeople: 2,
          failureSharePercent: 50,
        });
        return outcomes.find((row) => row.pattern === "first.last")?.demoted;
      };

      // Two people who had in fact left the company. The record cannot tell
      // that from a wrong convention, and demotes.
      await kill(
        fixture.colleagues[0]!.id,
        new Date("2026-08-18T09:00:00.000Z"),
      );
      await kill(
        fixture.colleagues[1]!.id,
        new Date("2026-08-18T09:05:00.000Z"),
      );
      await db.insert(schema.conventionDemotions).values({
        domain: fixture.domain,
        pattern: "first.last",
        demotedAt: new Date("2026-08-18T09:05:00.000Z"),
        peopleProvenDead: 2,
        peopleAttempted: 2,
      });
      expect(await demotedNow()).toBe(true);

      // Restoring is as demanding as removing a suppression: grounds in
      // writing, and an explicit statement of what the operator knows.
      const bare = await liftConventionDemotion(db, {
        domain: fixture.domain,
        pattern: "first.last",
        actor: "operator",
      });
      expect(bare).toMatchObject({
        ok: false,
        code: "LIFT_REQUIRES_JUSTIFICATION",
      });
      const unconfirmed = await liftConventionDemotion(db, {
        domain: fixture.domain,
        pattern: "first.last",
        actor: "operator",
        justification: "Both had left; HR confirmed",
      });
      expect(unconfirmed).toMatchObject({
        ok: false,
        code: "LIFT_REQUIRES_JUSTIFICATION",
      });
      expect(await demotedNow()).toBe(true);

      const lifted = await liftConventionDemotion(
        db,
        {
          domain: fixture.domain,
          pattern: "first.last",
          actor: "operator",
          justification: "Both had left; HR confirmed the convention",
          confirmedConventionInUse: true,
        },
        { now: new Date("2026-08-18T10:00:00.000Z") },
      );
      expect(lifted).toMatchObject({ ok: true, disposition: "lifted" });
      // The raw ratio is untouched — two of two are still dead. What changed is
      // that the record now starts from the moment the operator overruled it.
      expect(await demotedNow()).toBe(false);
      const [audit] = await db
        .select()
        .from(schema.stateTransitions)
        .where(eq(schema.stateTransitions.reason, "operator_lifted_demotion"));
      expect(audit?.actor).toBe("operator");

      // Being wrong costs the next failures, not nothing: two deaths after the
      // lift discredit it again, on the evidence gathered since.
      await kill(
        fixture.colleagues[2]!.id,
        new Date("2026-08-18T11:00:00.000Z"),
      );
      await kill(fixture.contact.id, new Date("2026-08-18T11:05:00.000Z"));
      expect(await demotedNow()).toBe(true);
    });

    it("re-latches a restored convention on the evidence gathered since, never on the evidence excused", async () => {
      await setLadderSettings({
        addressLadderDemotionMinimumPeople: 2,
        addressLadderDemotionFailureSharePercent: 50,
        addressLadderMaxAdvancesPerAccountPerDay: 10,
      });
      const fixture = await ladderFixture({ extraContacts: 3 });
      const kill = async (contactId: string, at: Date) => {
        const rows = await candidates(contactId);
        const row = rows.find(
          (candidate) => candidate.pattern === "first.last",
        );
        if (!row) throw new Error("no first.last rung");
        await db
          .update(schema.emailCandidates)
          .set({ deadAt: at, firstAttemptedAt: at })
          .where(eq(schema.emailCandidates.id, row.id));
      };
      const recordNow = async () => {
        const records = await readConventionDemotionRecords(db);
        return records.filter((row) => row.domain === fixture.domain);
      };

      // Two people who had left, and the verdict they produced.
      await kill(
        fixture.colleagues[0]!.id,
        new Date("2026-08-18T09:00:00.000Z"),
      );
      await kill(
        fixture.colleagues[1]!.id,
        new Date("2026-08-18T09:05:00.000Z"),
      );
      await db.insert(schema.conventionDemotions).values({
        domain: fixture.domain,
        pattern: "first.last",
        demotedAt: new Date("2026-08-18T09:05:00.000Z"),
        peopleProvenDead: 2,
        peopleAttempted: 2,
      });
      await liftConventionDemotion(
        db,
        {
          domain: fixture.domain,
          pattern: "first.last",
          actor: "operator",
          justification: "Reorganisation, not a bad convention",
          confirmedConventionInUse: true,
        },
        { now: new Date("2026-08-18T09:30:00.000Z") },
      );

      // One real failure since. Below the two-people floor, so the operator's
      // judgement stands — the excused pair is not quietly added back to it.
      await kill(
        fixture.colleagues[2]!.id,
        new Date("2026-08-18T10:15:00.000Z"),
      );
      const [afterOne] = await recordNow();
      expect(afterOne?.liftedAt).not.toBeNull();

      // A second, through the live bounce path, which is what writes verdicts.
      await hardBounce(fixture);

      const afterTwo = await recordNow();
      // One row per company and convention: the current verdict and the fact it
      // was once overruled live together.
      expect(afterTwo).toHaveLength(1);
      expect(afterTwo[0]?.liftedAt).toBeNull();
      // The counts are the two failures since the lift, never the four the
      // record now holds — reinstating the excused pair as evidence would make
      // the operator's judgement the thing that convicts them.
      expect(afterTwo[0]?.peopleProvenDead).toBe(2);
      expect(afterTwo[0]?.peopleAttempted).toBe(2);
    });

    it("keys the queued regeneration on the death that caused it", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      const deadMessageId = fixture.message!.id;

      await hardBounce(fixture);

      const queued = await db
        .select()
        .from(schema.operatorCommands)
        .where(eq(schema.operatorCommands.task, "generate-message"));
      // A rung number is rewritten by every demotion and every fresh
      // resolution, so two addresses on one enrollment can wear the same one.
      // One death advances the ladder exactly once, so its own id cannot.
      expect(
        queued.some((row) =>
          row.dedupeKey?.endsWith(
            `enrollment:${fixture.enrollmentId}:generate:0:after:${deadMessageId}`,
          ),
        ),
      ).toBe(true);
    });

    it("does not queue a second regeneration when the same bounce is reported twice", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture();
      const countAdvances = async () => {
        const rows = await db
          .select()
          .from(schema.operatorCommands)
          .where(eq(schema.operatorCommands.task, "generate-message"));
        return rows.filter((row) =>
          row.dedupeKey?.includes(
            `enrollment:${fixture.enrollmentId}:generate:0:after:`,
          ),
        ).length;
      };

      await hardBounce(fixture);
      expect(await countAdvances()).toBe(1);
      // A delivery report can be reprocessed. The death is recorded once, and
      // the request it produced is the same request.
      await hardBounce(fixture);
      expect(await countAdvances()).toBe(1);
      // And the suppression the same transaction wrote is still standing —
      // rolling it back to signal a queueing problem would undo the one fact
      // this product can establish about an address.
      const suppressed = await listSuppressions(db, { scope: "email" });
      expect(
        suppressed.some((entry) => entry.normalizedValue === fixture.rungOne),
      ).toBe(true);
    });

    it("records the address as dead and suppressed even when the sequence has already ended", async () => {
      await setLadderSettings({});
      const fixture = await ladderFixture({ send: false });
      const proposal = await generateOutreachProposal(db, {
        enrollmentId: fixture.enrollmentId,
        stepIndex: 0,
        recipient: fixture.rungOne,
      });
      if (!proposal.ok) throw new Error(proposal.message);
      const review = await reviewMessage(db, {
        messageId: proposal.message.id,
        action: { kind: "approve" },
        actor: "operator",
      });
      if (!review.ok) throw new Error(review.message);
      await db
        .update(schema.mailboxConnections)
        .set({ provider: "smtp_imap" })
        .where(eq(schema.mailboxConnections.id, fixture.mailbox.id));
      const mock = new MockMailProvider();
      let rejected = false;
      const provider: MailProvider = {
        kind: "smtp_imap",
        createDraft: (input) => mock.createDraft(input),
        sendDraft: async () => {
          rejected = true;
          throw new Error("550 5.1.1 No such user");
        },
        // The person replied while the transport was still deciding, which is
        // the only order in which this can happen: the send policy refuses a
        // terminal enrollment outright, so the sequence has to end between the
        // attempt and the report.
        reconcile: async (input) => {
          if (rejected) {
            await db
              .update(schema.enrollments)
              .set({
                state: "replied",
                stopReason: "positive_reply",
                stoppedAt: new Date("2026-08-18T10:15:00.000Z"),
              })
              .where(eq(schema.enrollments.id, fixture.enrollmentId));
          }
          return rejected
            ? {
                status: "rejected",
                draftId: input.draftId!,
                responseCode: 550,
                response: "550 5.1.1 No such user",
                smtpErrorCode: "EENVELOPE",
                hardBounce: true,
              }
            : mock.reconcile(input);
        },
      };
      await expect(
        sendApprovedMessage(db, provider, {
          messageId: proposal.message.id,
        }),
      ).resolves.toMatchObject({ ok: false, code: "PERMANENT_REJECTION" });

      // The address is dead whatever the sequence went on to do, and a
      // suppression that depends on the enrollment's state is not permanent.
      const suppressed = await listSuppressions(db, { scope: "email" });
      expect(
        suppressed.some((entry) => entry.normalizedValue === fixture.rungOne),
      ).toBe(true);
      const rows = await candidates(fixture.contact.id);
      expect(
        rows.find((row) => row.normalizedEmail === fixture.rungOne)?.deadAt,
      ).not.toBeNull();
      // And the reply still owns the enrollment.
      const row = await enrollmentRow(fixture.enrollmentId);
      expect(row.state).toBe("replied");
    });

    it("does not let one company's verdict reorder another company's addresses", async () => {
      await setLadderSettings({ addressLadderDemotionMinimumPeople: 2 });
      const fixture = await ladderFixture({ extraContacts: 1 });
      const colleague = fixture.colleagues[0]!;
      // Two people proven dead on `first.last` at the old company, which is the
      // demotion rule's own floor.
      for (const person of [colleague]) {
        const rows = await candidates(person.id);
        const row = rows.find(
          (candidate) => candidate.pattern === "first.last",
        );
        if (!row) throw new Error("no first.last rung");
        await db
          .update(schema.emailCandidates)
          .set({
            deadAt: new Date("2026-08-18T09:00:00.000Z"),
            firstAttemptedAt: new Date("2026-08-18T08:00:00.000Z"),
          })
          .where(eq(schema.emailCandidates.id, row.id));
      }

      // The contact has moved, and has been resolved at the new company: they
      // now hold addresses on both domains.
      const elsewhere = await createOrGetAccount(db, {
        name: `Elsewhere ${sequence}`,
        domain: `elsewhere-${sequence}.example`,
      });
      if (!elsewhere.ok) throw new Error(elsewhere.message);
      const newDomain = elsewhere.account.domain!;
      await db.insert(schema.emailCandidates).values([
        {
          contactId: fixture.contact.id,
          email: `alice.moved@${newDomain}`,
          normalizedEmail: `alice.moved@${newDomain}`,
          domain: newDomain,
          pattern: "first.last",
          confidence: "0.970",
          source: "public_pattern",
          status: "candidate",
          ladderRank: 1,
        },
        {
          contactId: fixture.contact.id,
          email: `a.moved@${newDomain}`,
          normalizedEmail: `a.moved@${newDomain}`,
          domain: newDomain,
          pattern: "f.last",
          confidence: "0.900",
          source: "public_pattern",
          status: "candidate",
          ladderRank: 2,
        },
      ]);
      await db
        .update(schema.contacts)
        .set({
          accountId: elsewhere.account.id,
          employmentVersion: fixture.contact.employmentVersion + 1,
        })
        .where(eq(schema.contacts.id, fixture.contact.id));

      await hardBounce(fixture);

      const after = await candidates(fixture.contact.id);
      const best = after.find(
        (row) => row.normalizedEmail === `alice.moved@${newDomain}`,
      );
      const second = after.find(
        (row) => row.normalizedEmail === `a.moved@${newDomain}`,
      );
      // The old employer discredited `first.last` for itself. The new employer
      // never ran it, and its best-evidenced address stays ahead.
      expect(best!.ladderRank).toBeLessThan(second!.ladderRank);
    });
  });
});
