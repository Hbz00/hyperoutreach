import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import {
  advanceAddressLadder,
  readAddressLadderMetrics,
} from "@/modules/email-resolution/ladder-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });
const now = new Date("2026-09-06T10:00:00Z");

async function accountFixture(label: string) {
  const account = await createOrGetAccount(db, {
    name: `Ladder accounting ${label}`,
    domain: `${label}.example.test`,
  });
  if (!account.ok) throw new Error(account.code);
  return account.account;
}

async function attemptedContact(
  account: Awaited<ReturnType<typeof accountFixture>>,
  label: string,
  attemptedAt = now,
) {
  const domain = account.domain!;
  const contact = await createOrGetContact(db, {
    accountId: account.id,
    firstName: label,
    lastName: "Audit",
    linkedinUrl: `https://www.linkedin.com/in/ladder-accounting-${label}`,
  });
  if (!contact.ok) throw new Error(contact.code);
  const nextAddress = `${label}.next@${domain}`;
  const firstAddress = `${label}.first@${domain}`;
  await db.insert(schema.emailCandidates).values([
    {
      contactId: contact.contact.id,
      email: firstAddress,
      normalizedEmail: firstAddress,
      domain,
      confidence: "0.900",
      source: "fixture",
      status: "accepted",
      ladderRank: 1,
      firstAttemptedAt: attemptedAt,
    },
    {
      contactId: contact.contact.id,
      email: nextAddress,
      normalizedEmail: nextAddress,
      domain,
      confidence: "0.800",
      source: "fixture",
      status: "candidate",
      ladderRank: 2,
    },
  ]);
  const campaign = await createDraftCampaign(db, {
    name: `Accounting ${label}`,
    type: "other",
    targetDescription: "Synthetic SQL accounting regression",
    configuration: {},
    steps: [
      { delayMinutes: 0, subjectTemplate: "Audit", bodyTemplate: "Audit" },
    ],
  });
  if (!campaign.ok) throw new Error(campaign.code);
  const published = await publishCampaignVersion(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
  });
  if (!published.ok) throw new Error(published.code);
  const enrolled = await enrollContact(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
    contactId: contact.contact.id,
  });
  if (!enrolled.ok) throw new Error(enrolled.code);
  // Persist a synthetic attempted message; this suite has no transport or AI.
  const [message] = await db
    .insert(schema.messages)
    .values({
      enrollmentId: enrolled.enrollment.id,
      stepIndex: 0,
      direction: "outbound",
      outreachId: `accounting-${label}`,
      subject: "Audit",
      body: "Audit",
      recipient: firstAddress,
      status: "sent",
      contactAccountId: account.id,
      employmentVersion: contact.contact.employmentVersion,
      sentAt: attemptedAt,
      sendAttemptedAt: attemptedAt,
    })
    .returning();
  if (!message) throw new Error("Message fixture failed");
  return {
    contactId: contact.contact.id,
    nextAddress,
    advance: (at = now) =>
      db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.enrollments)
          .where(eq(schema.enrollments.id, enrolled.enrollment.id))
          .for("update");
        return advanceAddressLadder(tx, {
          messageId: message.id,
          now: at,
          actor: "test",
        });
      }),
  };
}

async function moveContact(contactId: string, accountId: string) {
  // Discovery retains old candidate rows, rejects their current acceptance,
  // and moves accountId. The historical cap must survive these persisted changes.
  await db.transaction(async (tx) => {
    await tx
      .update(schema.emailCandidates)
      .set({ status: "rejected" })
      .where(eq(schema.emailCandidates.contactId, contactId));
    await tx
      .update(schema.contacts)
      .set({ accountId, employmentVersion: 2 })
      .where(eq(schema.contacts.id, contactId));
  });
}

describe("address ladder historical company accounting", () => {
  beforeEach(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(db, { migrationsFolder: "drizzle" });
    await db
      .update(schema.operatorSendingSettings)
      .set({
        addressLadderMaxAdvancesPerAccountPerDay: 1,
        addressLadderFailureRateMinimumSends: 100,
      })
      .where(eq(schema.operatorSendingSettings.id, 1));
  });
  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it("leaves a new employer its first allowance after an advanced contact arrives", async () => {
    const former = await accountFixture("former");
    const current = await accountFixture("current");
    const moved = await attemptedContact(former, "moved");
    expect(await moved.advance()).toMatchObject({
      kind: "advanced",
      normalizedEmail: moved.nextAddress,
    });
    await moveContact(moved.contactId, current.id);
    const colleague = await attemptedContact(current, "colleague");
    expect(await colleague.advance()).toMatchObject({
      kind: "advanced",
      normalizedEmail: colleague.nextAddress,
    });
  });

  it("keeps the former employer's allowance spent after an advanced contact leaves", async () => {
    const former = await accountFixture("former");
    const current = await accountFixture("current");
    const moved = await attemptedContact(former, "moved");
    expect(await moved.advance()).toMatchObject({ kind: "advanced" });
    await moveContact(moved.contactId, current.id);
    const colleague = await attemptedContact(former, "colleague");
    expect(await colleague.advance()).toEqual({
      kind: "not_advanced",
      reason: "account_daily_cap",
      endsEnrollment: false,
    });
  });

  it("still blocks a second advance at the same employer", async () => {
    const account = await accountFixture("same");
    const first = await attemptedContact(account, "first");
    expect(await first.advance()).toMatchObject({ kind: "advanced" });
    const second = await attemptedContact(account, "second");
    expect(await second.advance()).toEqual({
      kind: "not_advanced",
      reason: "account_daily_cap",
      endsEnrollment: false,
    });
  });

  it("reports advances by their original company after a contact moves", async () => {
    const former = await accountFixture("former");
    const current = await accountFixture("current");
    const moved = await attemptedContact(former, "moved");
    const colleague = await attemptedContact(current, "colleague");
    expect(await moved.advance()).toMatchObject({ kind: "advanced" });
    expect(await colleague.advance()).toMatchObject({ kind: "advanced" });
    expect(await readAddressLadderMetrics(db, { now })).toMatchObject({
      advancesLastDay: 2,
      busiestAccountAdvances: 1,
    });
    await moveContact(moved.contactId, current.id);
    expect(await readAddressLadderMetrics(db, { now })).toMatchObject({
      advancesLastDay: 2,
      busiestAccountAdvances: 1,
    });
  });

  it("expires an advance after the rolling day", async () => {
    const account = await accountFixture("expired");
    const yesterday = new Date(now.getTime() - 24 * 60 * 60_000 - 1);
    const first = await attemptedContact(account, "first", yesterday);
    expect(await first.advance(yesterday)).toMatchObject({ kind: "advanced" });
    const second = await attemptedContact(account, "second");
    expect(await second.advance()).toMatchObject({
      kind: "advanced",
      normalizedEmail: second.nextAddress,
    });
    expect(await readAddressLadderMetrics(db, { now })).toMatchObject({
      advancesLastDay: 1,
      busiestAccountAdvances: 1,
    });
  });
});
