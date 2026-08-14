import { and, eq } from "drizzle-orm";
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
  reviseCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });

describe("database-backed reliable outreach vertical slice", () => {
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
    await client.end();
  });

  it("deduplicates accounts and contacts by their strongest available identity", async () => {
    const acme = await createOrGetAccount(db, {
      name: "Acme France",
      domain: "https://www.acme.example/about",
    });
    expect(acme.ok).toBe(true);
    if (!acme.ok) return;
    expect(acme.disposition).toBe("created");

    const renamedAcme = await createOrGetAccount(db, {
      name: "Acme Renamed",
      domain: "ACME.EXAMPLE",
    });
    expect(renamedAcme).toMatchObject({
      ok: true,
      disposition: "existing",
      account: { id: acme.account.id },
    });

    const otherAcme = await createOrGetAccount(db, {
      name: "Acme France",
      domain: "acme.fr",
    });
    expect(otherAcme).toMatchObject({ ok: true, disposition: "created" });
    if (!otherAcme.ok) return;
    expect(otherAcme.account.id).not.toBe(acme.account.id);

    const domainBearingSharedName = await createOrGetAccount(db, {
      name: "Shared Identity",
      domain: "shared-identity.example",
    });
    const domainlessSharedName = await createOrGetAccount(db, {
      name: "Shared Identity",
    });
    expect(domainBearingSharedName.ok && domainlessSharedName.ok).toBe(true);
    if (!domainBearingSharedName.ok || !domainlessSharedName.ok) return;
    expect(domainlessSharedName).toMatchObject({ disposition: "existing" });
    expect(domainlessSharedName.account.id).toBe(
      domainBearingSharedName.account.id,
    );

    const weakBeforeDomain = await createOrGetAccount(db, {
      name: "Weak Before Domain",
    });
    expect(weakBeforeDomain.ok).toBe(true);
    if (!weakBeforeDomain.ok) return;
    const enrichedWeak = await createOrGetAccount(db, {
      name: "Weak Before Domain",
      domain: "weak-before-domain.example",
    });
    expect(enrichedWeak).toMatchObject({
      ok: true,
      disposition: "existing",
      account: {
        id: weakBeforeDomain.account.id,
        domain: "weak-before-domain.example",
      },
    });

    const ambiguousOne = await createOrGetAccount(db, {
      name: "Ambiguous Holdings",
      domain: "ambiguous-one.example",
    });
    const ambiguousTwo = await createOrGetAccount(db, {
      name: "Ambiguous Holdings",
      domain: "ambiguous-two.example",
    });
    expect(ambiguousOne.ok && ambiguousTwo.ok).toBe(true);
    await expect(
      createOrGetAccount(db, { name: "Ambiguous Holdings" }),
    ).resolves.toEqual({
      ok: false,
      code: "AMBIGUOUS_IDENTITY",
      message: "Company name matches multiple domains; provide a domain",
    });

    const domainless = await createOrGetAccount(db, { name: "No Domain SAS" });
    const duplicateDomainless = await createOrGetAccount(db, {
      name: " no-domain, sas ",
    });
    expect(domainless.ok && duplicateDomainless.ok).toBe(true);
    if (!domainless.ok || !duplicateDomainless.ok) return;
    expect(duplicateDomainless).toMatchObject({
      disposition: "existing",
      account: { id: domainless.account.id },
    });

    const alice = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Alice",
      lastName: "Martin",
      jobTitle: "VP Sales",
      linkedinUrl: "https://linkedin.com/in/alice-martin/?trk=one",
    });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    const movedAlice = await createOrGetContact(db, {
      accountId: otherAcme.account.id,
      firstName: "Alice",
      lastName: "Martin-Smith",
      linkedinUrl: "https://www.linkedin.com/in/ALICE-MARTIN",
    });
    expect(movedAlice).toMatchObject({
      ok: true,
      disposition: "existing",
      contact: { id: alice.contact.id },
    });

    const noLinkedInAlice = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Alice",
      lastName: "Martin",
    });
    expect(noLinkedInAlice.ok).toBe(true);
    if (!noLinkedInAlice.ok) return;
    expect(noLinkedInAlice).toMatchObject({ disposition: "created" });
    expect(noLinkedInAlice.contact.id).not.toBe(alice.contact.id);

    const unlinkedCarol = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Carol",
      lastName: "Jones",
    });
    expect(unlinkedCarol.ok).toBe(true);
    if (!unlinkedCarol.ok) return;
    const enrichedCarol = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Carol",
      lastName: "Jones",
      linkedinUrl:
        "https://linkedin.com/in/Carol-Jones/details/recent-activity/",
    });
    expect(enrichedCarol).toMatchObject({
      ok: true,
      disposition: "existing",
      contact: {
        id: unlinkedCarol.contact.id,
        linkedinUrl: "https://www.linkedin.com/in/carol-jones",
      },
    });

    const unlinkedDana = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Dana",
      lastName: "Ray",
    });
    expect(unlinkedDana.ok).toBe(true);
    if (!unlinkedDana.ok) return;
    const concurrentDana = await Promise.all([
      createOrGetContact(db, {
        accountId: acme.account.id,
        firstName: "Dana",
        lastName: "Ray",
        linkedinUrl: "https://linkedin.com/in/dana-ray",
      }),
      createOrGetContact(db, {
        accountId: acme.account.id,
        firstName: "Dana",
        lastName: "Ray",
        linkedinUrl: "https://www.linkedin.com/in/DANA-RAY/",
      }),
    ]);
    expect(concurrentDana.every((result) => result.ok)).toBe(true);
    expect(
      concurrentDana.map((result) => (result.ok ? result.contact.id : null)),
    ).toEqual([unlinkedDana.contact.id, unlinkedDana.contact.id]);

    const firstChris = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Chris",
      lastName: "Lee",
      linkedinUrl: "https://linkedin.com/in/chris-lee-one",
    });
    const secondChris = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Chris",
      lastName: "Lee",
      linkedinUrl: "https://linkedin.com/in/chris-lee-two",
    });
    expect(firstChris.ok && secondChris.ok).toBe(true);
    if (!firstChris.ok || !secondChris.ok) return;
    expect(firstChris.contact.id).not.toBe(secondChris.contact.id);

    const bob = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: "Bob",
      lastName: "Stone",
    });
    const duplicateBob = await createOrGetContact(db, {
      accountId: acme.account.id,
      firstName: " BOB ",
      lastName: " STONE ",
    });
    expect(bob.ok && duplicateBob.ok).toBe(true);
    if (!bob.ok || !duplicateBob.ok) return;
    expect(duplicateBob).toMatchObject({
      disposition: "existing",
      contact: { id: bob.contact.id },
    });

    const invalid = await createOrGetAccount(db, { name: " ", domain: "bad" });
    expect(invalid).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid account input",
    });
  });

  it("accepts one operator-provided company email and replaces the prior accepted candidate", async () => {
    const account = await createOrGetAccount(db, {
      name: "Manual Email Co",
      domain: "manual-email.example",
    });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const contact = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: "Marie",
      lastName: "Curie",
      jobTitle: "Founder",
    });
    expect(contact.ok).toBe(true);
    if (!contact.ok) return;

    expect(
      await acceptManualEmail(db, {
        contactId: contact.contact.id,
        email: "marie@other.example",
        actor: "operator@example.com",
      }),
    ).toEqual({ ok: false, code: "DOMAIN_MISMATCH" });

    const first = await acceptManualEmail(db, {
      contactId: contact.contact.id,
      email: "marie@manual-email.example",
      actor: "operator@example.com",
    });
    expect(first).toMatchObject({
      ok: true,
      candidate: {
        normalizedEmail: "marie@manual-email.example",
        status: "accepted",
        source: "operator_manual",
      },
    });
    const second = await acceptManualEmail(db, {
      contactId: contact.contact.id,
      email: "m.curie@manual-email.example",
      actor: "operator@example.com",
    });
    expect(second).toMatchObject({
      ok: true,
      candidate: {
        normalizedEmail: "m.curie@manual-email.example",
        status: "accepted",
      },
    });
    expect(
      await db
        .select()
        .from(schema.emailCandidates)
        .where(
          and(
            eq(schema.emailCandidates.contactId, contact.contact.id),
            eq(schema.emailCandidates.status, "accepted"),
          ),
        ),
    ).toHaveLength(1);
    const [storedContact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contact.contact.id));
    expect(storedContact).toMatchObject({
      status: "email_resolved",
      emailResolutionStatus: "resolved",
      emailResolutionReason: null,
    });
  });

  it("pins immutable published versions and idempotently generates, reviews, and sends", async () => {
    const account = await createOrGetAccount(db, {
      name: "Reliable Corp",
      domain: "reliable.example",
    });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const contact = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: "Jane",
      lastName: "Doe",
      jobTitle: "COO",
    });
    expect(contact.ok).toBe(true);
    if (!contact.ok) return;

    const draft = await createDraftCampaign(db, {
      name: "Operations discovery",
      type: "customer_discovery",
      targetDescription: "COOs at European B2B software companies",
      configuration: { reviewMode: "manual" },
      steps: [
        {
          delayMinutes: 0,
          subjectTemplate: "Question for {{company}}",
          bodyTemplate: "Hello {{first_name}}, your role is {{job_title}}.",
        },
        {
          delayMinutes: 4_320,
          subjectTemplate: "Following up, {{first_name}}",
          bodyTemplate: "Hello {{first_name}}, following up about {{company}}.",
        },
      ],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.version).toMatchObject({ version: 1, publishedAt: null });
    expect(draft.steps.map((step) => step.stepIndex)).toEqual([0, 1]);

    const publishedV1 = await publishCampaignVersion(db, {
      campaignId: draft.campaign.id,
      campaignVersionId: draft.version.id,
    });
    expect(publishedV1).toMatchObject({
      ok: true,
      disposition: "published",
      version: { version: 1 },
    });

    const revised = await reviseCampaignVersion(db, {
      campaignId: draft.campaign.id,
      baseVersionId: draft.version.id,
      configuration: { reviewMode: "manual", variant: "short" },
      steps: [
        {
          delayMinutes: 0,
          subjectTemplate: "New subject for {{company}}",
          bodyTemplate: "New body for {{first_name}}",
        },
      ],
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised).toMatchObject({
      disposition: "created_next_version",
      version: { version: 2, publishedAt: null },
    });

    const [originalStep] = await db
      .select()
      .from(schema.sequenceSteps)
      .where(
        and(
          eq(schema.sequenceSteps.campaignVersionId, draft.version.id),
          eq(schema.sequenceSteps.stepIndex, 0),
        ),
      );
    expect(originalStep?.subjectTemplate).toBe("Question for {{company}}");

    const mailboxRows = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "mock",
        email: "operator@example.com",
        normalizedEmail: "operator@example.com",
        status: "available",
      })
      .returning();
    const mailbox = mailboxRows[0];
    expect(mailbox).toBeDefined();
    if (!mailbox) return;

    const enrollment = await enrollContact(db, {
      campaignId: draft.campaign.id,
      campaignVersionId: draft.version.id,
      contactId: contact.contact.id,
      mailboxId: mailbox.id,
    });
    const duplicateEnrollment = await enrollContact(db, {
      campaignId: draft.campaign.id,
      campaignVersionId: draft.version.id,
      contactId: contact.contact.id,
      mailboxId: mailbox.id,
    });
    expect(enrollment.ok).toBe(true);
    if (!enrollment.ok) return;
    expect(duplicateEnrollment).toMatchObject({
      ok: true,
      disposition: "existing",
      enrollment: { id: enrollment.enrollment.id },
    });
    expect(enrollment.enrollment.campaignVersionId).toBe(draft.version.id);

    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: "Jane.Doe@Reliable.Example",
    });
    const duplicateProposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: "jane.doe@reliable.example",
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.message).toMatchObject({
      subject: "Question for Reliable Corp",
      body: "Hello Jane, your role is COO.",
      recipient: "jane.doe@reliable.example",
      status: "proposed",
    });
    expect(proposal.message.outreachId).toMatch(/^out_[0-9a-f-]{36}$/);
    expect(duplicateProposal).toMatchObject({
      ok: true,
      disposition: "existing",
      message: { id: proposal.message.id },
    });

    const reviewed = await reviewMessage(db, {
      messageId: proposal.message.id,
      action: {
        kind: "edit_and_approve",
        subject: "Exact approved subject",
        body: "Exact approved body",
      },
      actor: "operator",
    });
    expect(reviewed).toMatchObject({
      ok: true,
      message: {
        status: "approved",
        subject: "Exact approved subject",
        body: "Exact approved body",
      },
    });

    const provider = new MockMailProvider();
    const firstSend = await sendApprovedMessage(db, provider, {
      messageId: proposal.message.id,
    });
    const duplicateSend = await sendApprovedMessage(db, provider, {
      messageId: proposal.message.id,
    });
    expect(firstSend).toMatchObject({ ok: true, disposition: "sent" });
    expect(duplicateSend).toMatchObject({
      ok: true,
      disposition: "already_sent",
    });
    expect(provider.deliveries).toHaveLength(1);
    expect(provider.deliveries[0]).toMatchObject({
      outreachId: proposal.message.outreachId,
      subject: "Exact approved subject",
      body: "Exact approved body",
      headers: { "X-Outreach-ID": proposal.message.outreachId },
    });

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, proposal.message.id));
    expect(stored).toMatchObject({
      status: "sent",
      subject: "Exact approved subject",
      body: "Exact approved body",
    });
    expect(stored?.providerDraftId).toBeTruthy();
    expect(stored?.providerMessageId).toBeTruthy();
    expect(stored?.sentAt).toBeInstanceOf(Date);

    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, proposal.message.id));
    expect(transitions.map((transition) => transition.toState)).toEqual(
      expect.arrayContaining(["proposed", "approved", "drafted", "sent"]),
    );
    const events = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, proposal.message.id));
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "message.proposed",
        "message.approved",
        "message.drafted",
        "message.sent",
      ]),
    );
    const approvalEvent = events.find(
      (event) => event.event === "message.approved",
    );
    expect(approvalEvent?.payload).toMatchObject({
      originalSubject: "Question for Reliable Corp",
      originalBody: "Hello Jane, your role is COO.",
      approvedSubject: "Exact approved subject",
      approvedBody: "Exact approved body",
    });
  });

  it("blocks rejected and globally suppressed recipients before provider calls", async () => {
    const account = await createOrGetAccount(db, {
      name: "Blocked Corp",
      domain: "blocked.example",
    });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const contact = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: "Sam",
      lastName: "Blocked",
      jobTitle: "CEO",
    });
    expect(contact.ok).toBe(true);
    if (!contact.ok) return;
    const blockedContact = contact.contact;

    async function preparedMessage(campaignName: string, recipient: string) {
      const draft = await createDraftCampaign(db, {
        name: campaignName,
        type: "commercial_outreach",
        targetDescription: "Relevant CEOs",
        configuration: {},
        steps: [
          {
            delayMinutes: 0,
            subjectTemplate: "Hello {{first_name}}",
            bodyTemplate: "Hello {{first_name}} at {{company}}",
          },
        ],
      });
      if (!draft.ok) throw new Error(draft.message);
      const published = await publishCampaignVersion(db, {
        campaignId: draft.campaign.id,
        campaignVersionId: draft.version.id,
      });
      if (!published.ok) throw new Error(published.message);
      const enrollment = await enrollContact(db, {
        campaignId: draft.campaign.id,
        campaignVersionId: draft.version.id,
        contactId: blockedContact.id,
      });
      if (!enrollment.ok) throw new Error(enrollment.message);
      const proposal = await generateOutreachProposal(db, {
        enrollmentId: enrollment.enrollment.id,
        stepIndex: 0,
        recipient,
      });
      if (!proposal.ok) throw new Error(proposal.message);
      return proposal.message;
    }

    const rejectedMessage = await preparedMessage(
      "Rejected Campaign",
      "rejected@blocked.example",
    );
    const rejected = await reviewMessage(db, {
      messageId: rejectedMessage.id,
      action: { kind: "reject", reason: "Poor fit" },
      actor: "operator",
    });
    expect(rejected).toMatchObject({
      ok: true,
      message: { status: "cancelled" },
    });
    const provider = new MockMailProvider();
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: rejectedMessage.id,
      }),
    ).toEqual({ ok: false, code: "MESSAGE_NOT_APPROVED" });

    const suppressedMessage = await preparedMessage(
      "Suppressed Campaign",
      "suppressed@blocked.example",
    );
    await reviewMessage(db, {
      messageId: suppressedMessage.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: "suppressed@blocked.example",
      reason: "unsubscribe",
    });
    expect(
      await sendApprovedMessage(db, provider, {
        messageId: suppressedMessage.id,
      }),
    ).toEqual({ ok: false, code: "RECIPIENT_SUPPRESSED" });
    expect(provider.deliveries).toHaveLength(0);

    const recoveredMessage = await preparedMessage(
      "Recovery Campaign",
      "recovered@blocked.example",
    );
    await reviewMessage(db, {
      messageId: recoveredMessage.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    const recoveryProvider = new MockMailProvider();
    const recoveredDraft = await recoveryProvider.createDraft({
      outreachId: recoveredMessage.outreachId!,
      mailboxId: null,
      sender: null,
      recipient: recoveredMessage.recipient,
      subject: recoveredMessage.subject,
      body: recoveredMessage.body,
      headers: { "X-Outreach-ID": recoveredMessage.outreachId! },
    });
    await recoveryProvider.sendDraft({
      draftId: recoveredDraft.draftId,
      outreachId: recoveredMessage.outreachId!,
      mailboxId: null,
    });

    expect(
      await sendApprovedMessage(db, recoveryProvider, {
        messageId: recoveredMessage.id,
      }),
    ).toMatchObject({ ok: true, disposition: "sent" });
    const [recoveredEnrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, recoveredMessage.enrollmentId));
    expect(recoveredEnrollment).toMatchObject({
      state: "completed",
      stopReason: "sequence_complete",
    });
    const recoveredEvents = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, recoveredMessage.id));
    expect(recoveredEvents.map((event) => event.event)).toContain(
      "message.sent",
    );
    expect(recoveryProvider.deliveries).toHaveLength(1);

    const lateSuppressedMessage = await preparedMessage(
      "Late Suppression Campaign",
      "late-suppressed@blocked.example",
    );
    await reviewMessage(db, {
      messageId: lateSuppressedMessage.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    class SuppressingDraftProvider extends MockMailProvider {
      override async createDraft(
        input: Parameters<MockMailProvider["createDraft"]>[0],
      ) {
        const draft = await super.createDraft(input);
        await db.insert(schema.suppressionEntries).values({
          scope: "email",
          normalizedValue: input.recipient,
          reason: "unsubscribe",
        });
        return draft;
      }
    }
    const lateSuppressionProvider = new SuppressingDraftProvider();
    expect(
      await sendApprovedMessage(db, lateSuppressionProvider, {
        messageId: lateSuppressedMessage.id,
      }),
    ).toEqual({ ok: false, code: "RECIPIENT_SUPPRESSED" });
    expect(lateSuppressionProvider.deliveries).toHaveLength(0);
  });
});
