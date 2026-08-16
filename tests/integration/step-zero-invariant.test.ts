import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { enrollContact } from "@/modules/campaigns/service";
import {
  findDueEnrollments,
  processFollowUpInvocation,
} from "@/modules/workflows/follow-up-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

async function enrolledContact() {
  const suffix = crypto.randomUUID();
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `Step zero ${suffix}`, normalizedName: `step-${suffix}` })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Alan",
      lastName: "Turing",
      fullName: "Alan Turing",
      normalizedFullName: `alan-${suffix}`,
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Step zero ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Keep step zero out of the follow-up machinery",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({
      campaignId: campaign!.id,
      version: 1,
      configuration: { automaticFollowUps: true },
    })
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
      bodyTemplate: "Following up about {{company}}",
    },
  ]);
  await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id));
  const enrolled = await enrollContact(db, {
    campaignId: campaign!.id,
    campaignVersionId: version!.id,
    contactId: contact!.id,
  });
  if (!enrolled.ok) throw new Error(enrolled.message);
  return { enrollment: enrolled.enrollment, versionId: version!.id };
}

// The one invariant `reviewMode` pretended to configure. It is enforced here
// instead: no first email can be originated by the system, whatever a campaign
// asks for. `automaticFollowUps` is deliberately on in the fixture — it
// automates steps one and up, and must not reach step zero.
describe("no first send is ever system-originated", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("leaves a fresh enrollment with nothing scheduled", async () => {
    const { enrollment } = await enrolledContact();

    expect(enrollment).toMatchObject({
      state: "ready_for_review",
      currentStep: 0,
      nextActionAt: null,
      nextActionToken: null,
    });
  });

  it("never reports a fresh enrollment as due", async () => {
    const { enrollment } = await enrolledContact();

    const due = await findDueEnrollments(db, { now: NOW, limit: 200 });

    expect(due.map((item) => item.enrollmentId)).not.toContain(enrollment.id);
  });

  // Even handed the invocation directly, the follow-up executor cannot serve
  // step zero: it joins the message of the previous step, and there is none.
  it("refuses to advance a sequence that has not sent its first message", async () => {
    const { enrollment, versionId } = await enrolledContact();

    const result = await processFollowUpInvocation(
      db,
      new MockMailProvider(),
      {
        enrollmentId: enrollment.id,
        expectedStep: 0,
        expectedVersionId: versionId,
        expectedDueAt: NOW,
        expectedToken: "forged-token",
      },
      { now: NOW },
    );

    expect(result.ok).toBe(false);
    const [messages] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.enrollmentId, enrollment.id));
    expect(messages).toBeUndefined();
  });
});
