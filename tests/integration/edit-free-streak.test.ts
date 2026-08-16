import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { readEditFreeStreaks } from "@/modules/campaigns/edit-streak";
import { reviewMessage } from "@/modules/messages/review-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

async function campaignVersion(name: string) {
  const suffix = crypto.randomUUID();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Measure how often the operator rewrites the template",
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
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `${name} account`, normalizedName: `streak-${suffix}` })
    .returning();
  return { campaign: campaign!, version: version!, account: account! };
}

/** One approval, on its own prospect, so each review is a real transition. */
async function approve(
  fixture: Awaited<ReturnType<typeof campaignVersion>>,
  options: { edited: boolean },
) {
  const suffix = crypto.randomUUID();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: fixture.account.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      normalizedFullName: `ada-${suffix}`,
    })
    .returning();
  const [enrollment] = await db
    .insert(schema.enrollments)
    .values({
      campaignId: fixture.campaign.id,
      campaignVersionId: fixture.version.id,
      contactId: contact!.id,
      state: "ready_for_review",
    })
    .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      enrollmentId: enrollment!.id,
      stepIndex: 0,
      direction: "outbound",
      outreachId: `out_${suffix}`,
      subject: "Hello Ada",
      body: "A note",
      recipient: `ada-${suffix}@example.com`,
      contactAccountId: fixture.account.id,
      employmentVersion: contact!.employmentVersion,
      status: "proposed",
    })
    .returning();
  const result = await reviewMessage(db, {
    messageId: message!.id,
    actor: "operator",
    action: options.edited
      ? { kind: "edit_and_approve", subject: "Rewritten", body: "Rewritten" }
      : { kind: "approve" },
  });
  if (!result.ok) throw new Error(result.message);
}

describe("edit-free approval streak", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("reports nothing before anything has been approved", async () => {
    expect(await readEditFreeStreaks(db)).toEqual([]);
  });

  it("counts consecutive approvals the operator did not rewrite", async () => {
    const fixture = await campaignVersion("Untouched");
    for (let index = 0; index < 3; index += 1) {
      await approve(fixture, { edited: false });
    }

    const streaks = await readEditFreeStreaks(db);

    expect(
      streaks.find((row) => row.campaignName === "Untouched"),
    ).toMatchObject({ version: 1, streak: 3, total: 3 });
  });

  // The streak is evidence that review has stopped changing anything. One
  // rewrite means it still does, so the count starts again from there.
  it("restarts the count at the last rewrite", async () => {
    const fixture = await campaignVersion("Rewritten once");
    await approve(fixture, { edited: false });
    await approve(fixture, { edited: true });
    await approve(fixture, { edited: false });
    await approve(fixture, { edited: false });

    const streaks = await readEditFreeStreaks(db);

    expect(
      streaks.find((row) => row.campaignName === "Rewritten once"),
    ).toMatchObject({ streak: 2, total: 4 });
  });

  it("reports zero while the most recent approval was a rewrite", async () => {
    const fixture = await campaignVersion("Just rewritten");
    await approve(fixture, { edited: false });
    await approve(fixture, { edited: true });

    const streaks = await readEditFreeStreaks(db);

    expect(
      streaks.find((row) => row.campaignName === "Just rewritten"),
    ).toMatchObject({ streak: 0, total: 2 });
  });

  it("keeps every campaign version on its own count", async () => {
    const first = await campaignVersion("Version A");
    const second = await campaignVersion("Version B");
    await approve(first, { edited: false });
    await approve(second, { edited: true });

    const streaks = await readEditFreeStreaks(db);

    expect(
      streaks.find((row) => row.campaignName === "Version A"),
    ).toMatchObject({ streak: 1 });
    expect(
      streaks.find((row) => row.campaignName === "Version B"),
    ).toMatchObject({ streak: 0 });
  });
});
