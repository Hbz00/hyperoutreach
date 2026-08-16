import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import {
  readSendPolicyVerdict,
  sendApprovedMessage,
} from "@/modules/messages/send-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

let fixtureNumber = 0;

async function seed() {
  fixtureNumber += 1;
  const suffix = `${fixtureNumber}-${crypto.randomUUID()}`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "mock",
      email: `operator-${suffix}@example.com`,
      normalizedEmail: `operator-${suffix}@example.com`,
      status: "available",
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      name: `Visibility ${suffix}`,
      normalizedName: `visibility-${suffix}`,
    })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Grace",
      lastName: "Hopper",
      fullName: "Grace Hopper",
      normalizedFullName: `grace-${suffix}`,
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Visibility ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Show the operator what a send actually did",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
    .returning();
  await db.insert(schema.sequenceSteps).values({
    campaignVersionId: version!.id,
    stepIndex: 0,
    delayMinutes: 0,
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "A note for {{company}}",
  });
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
      state: "approved",
    })
    .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      enrollmentId: enrollment!.id,
      mailboxId: mailbox!.id,
      stepIndex: 0,
      direction: "outbound",
      outreachId: `out_${crypto.randomUUID()}`,
      subject: "Hello Grace",
      body: "A note for Visibility",
      recipient: `grace-${crypto.randomUUID()}@example.com`,
      contactAccountId: account!.id,
      employmentVersion: contact!.employmentVersion,
      status: "approved",
    })
    .returning();
  return { mailbox: mailbox!, message: message! };
}

async function sendingSettings(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const result = await updateOperatorSendingSettings(db, {
    emergencyPause: false,
    timezone: "UTC",
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    workingStartMinute: 0,
    workingEndMinute: 1_440,
    mailboxDailyCap: 1_000,
    campaignDailyCap: 1_000,
    mailboxMinimumDelaySeconds: 0,
    contactMinimumDelayMinutes: 0,
    crossCampaignCooldownDays: 0,
    ...overrides,
    actor: "operator",
  });
  if (!result.ok) throw new Error(result.code);
}

describe("send visibility", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await sendingSettings();
  });

  // An audit that records a refusal once and then goes quiet cannot answer
  // "is this still happening?" — which is the only question an operator asks
  // of it.
  it("records every refusal, not only the first", async () => {
    const fixture = await seed();
    await sendingSettings({ emergencyPause: true });
    const provider = new DatabaseMockMailProvider(db);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await sendApprovedMessage(
          db,
          provider,
          { messageId: fixture.message.id },
          { clock: () => NOW },
        ),
      ).toMatchObject({ ok: false, code: "EMERGENCY_PAUSED" });
    }

    const rows = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, fixture.message.id));
    const blocked = rows.filter((row) => row.event === "message.send_blocked");
    expect(blocked).toHaveLength(2);
  });

  it("reads the current policy verdict without sending anything", async () => {
    const fixture = await seed();
    await sendingSettings({ emergencyPause: true });

    expect(
      await readSendPolicyVerdict(db, fixture.message.id, "mock", NOW),
    ).toMatchObject({ ok: false, code: "EMERGENCY_PAUSED" });

    const stored = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored[0]).toMatchObject({ status: "approved", attemptCount: 0 });
  });

  it("reports a message that would go out right now", async () => {
    const fixture = await seed();

    expect(
      await readSendPolicyVerdict(db, fixture.message.id, "mock", NOW),
    ).toEqual({ ok: true });
  });

  it("reports nothing for a message that does not exist", async () => {
    expect(
      await readSendPolicyVerdict(
        db,
        "00000000-0000-0000-0000-000000000000",
        "mock",
        NOW,
      ),
    ).toBeNull();
  });
});
