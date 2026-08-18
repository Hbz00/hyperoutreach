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
import { resolveContactEmail } from "@/modules/email-resolution/service";
import {
  readAddressLadderMetrics,
  readConventionOutcomes,
  readBlockedRungs,
  readLadderSettings,
} from "@/modules/email-resolution/ladder-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { generateWithPersonalization } from "@/modules/messages/personalized-generation";
import { MockPersonalizationAgent } from "@/modules/agents/mock-agents";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { listSuppressions } from "@/modules/suppression/service";
import { findDueEnrollments } from "@/modules/workflows/follow-up-service";

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
    expect(contact?.emailResolutionReason).toBe("ladder_limit_reached");
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
      metrics.sendsAttempted - metrics.sendsProvenDead,
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
});
