import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  enrollSelection,
  MAXIMUM_ENROLLMENTS_PER_REQUEST,
  readEnrollmentCandidates,
} from "@/modules/campaigns/enrollment-selection";
import { enrollContact } from "@/modules/campaigns/service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-18T09:00:00.000Z");

let sequence = 0;

async function company(name: string) {
  sequence += 1;
  const [account] = await db
    .insert(schema.accounts)
    .values({ name, normalizedName: `${name}-${sequence}`.toLowerCase() })
    .returning();
  return account!;
}

async function person(
  account: typeof schema.accounts.$inferSelect,
  options: {
    fullName?: string;
    jobTitle?: string | null;
    email?: string;
    confidence?: string;
    accepted?: boolean;
  } = {},
) {
  sequence += 1;
  const suffix = `${sequence}`;
  const fullName = options.fullName ?? `Person ${suffix}`;
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account.id,
      firstName: "Given",
      lastName: `Family ${suffix}`,
      fullName,
      normalizedFullName: `person-${suffix}`,
      jobTitle: options.jobTitle === undefined ? "Analyst" : options.jobTitle,
      emailResolutionStatus: "resolved",
    })
    .returning();
  const email = options.email ?? `person-${suffix}@example.com`;
  if (options.accepted !== false) {
    await db.insert(schema.emailCandidates).values({
      contactId: contact!.id,
      email,
      normalizedEmail: email,
      domain: email.split("@")[1]!,
      confidence: options.confidence ?? "0.900",
      source: "fixture",
      status: "accepted",
    });
  }
  return contact!;
}

async function campaign(name: string) {
  sequence += 1;
  const [row] = await db
    .insert(schema.campaigns)
    .values({
      name,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Enrollment selection fixture",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: row!.id, version: 1 })
    .returning();
  // Steps before publication: `prevent_used_sequence_step_mutation` refuses to
  // add one to a published version, which is the immutability the product
  // promises rather than something to work around.
  await db.insert(schema.sequenceSteps).values({
    campaignVersionId: version!.id,
    stepIndex: 0,
    delayMinutes: 0,
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "A note for {{company}}",
  });
  const [published] = await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id))
    .returning();
  return { campaign: row!, version: published! };
}

async function candidatesFor(campaignId: string, filters = {}) {
  return readEnrollmentCandidates(db, { campaignId, filters });
}

// One schema and one connection for the whole file: the two suites below share
// this client, so ending it inside the first would cut the second off.
beforeAll(async () => {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await client.end();
});

describe("the enrollment screen and its action read one list", () => {
  it("offers a contact with an accepted address", async () => {
    const account = await company("Offered Ltd");
    const contact = await person(account, { fullName: "Ada Offered" });
    const { campaign: target } = await campaign("Offered campaign");

    const rows = await candidatesFor(target.id);

    expect(rows).toContainEqual(
      expect.objectContaining({
        contactId: contact.id,
        fullName: "Ada Offered",
        company: "Offered Ltd",
        confidence: 0.9,
        ineligibility: null,
      }),
    );
  });

  // No accepted address means no address to write to. These never reach the
  // screen at all, not even as an excluded count.
  it("does not mention a contact without an accepted address", async () => {
    const account = await company("Unresolved Ltd");
    const contact = await person(account, { accepted: false });
    const { campaign: target } = await campaign("Unresolved campaign");

    const rows = await candidatesFor(target.id);

    expect(rows.map((row) => row.contactId)).not.toContain(contact.id);
  });

  it("labels a contact already enrolled in this campaign", async () => {
    const account = await company("Enrolled Ltd");
    const contact = await person(account);
    const { campaign: target, version } = await campaign("Enrolled campaign");
    const enrolled = await enrollContact(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      contactId: contact.id,
    });
    expect(enrolled.ok).toBe(true);

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: "already_enrolled",
    });
  });

  // Queueing somebody for the campaign that comes next is ordinary work, and a
  // sequence still running elsewhere is a question of *when* they may be
  // written to — which the send policy owns and applies when it can actually
  // be judged. Deciding it here would be a second, staler copy of that rule.
  it("offers a contact running a sequence in another campaign", async () => {
    const account = await company("Busy Ltd");
    const contact = await person(account);
    const other = await campaign("Other campaign");
    const { campaign: target } = await campaign("Target campaign");
    const enrolled = await enrollContact(db, {
      campaignId: other.campaign.id,
      campaignVersionId: other.version.id,
      contactId: contact.id,
    });
    expect(enrolled.ok).toBe(true);

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: null,
    });
  });

  // A finished sequence elsewhere is not a reason to hide somebody: a prospect
  // who replied to a discovery campaign is a legitimate target for another.
  it("offers a contact whose other enrollment has ended", async () => {
    const account = await company("Finished Ltd");
    const contact = await person(account);
    const other = await campaign("Finished campaign");
    const { campaign: target } = await campaign("Second campaign");
    const enrolled = await enrollContact(db, {
      campaignId: other.campaign.id,
      campaignVersionId: other.version.id,
      contactId: contact.id,
    });
    if (!enrolled.ok) throw new Error(enrolled.message);
    await db
      .update(schema.enrollments)
      .set({ state: "replied", stopReason: "positive_reply", stoppedAt: NOW })
      .where(eq(schema.enrollments.id, enrolled.enrollment.id));

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: null,
    });
  });

  it("labels a contact whose address is suppressed", async () => {
    const account = await company("Suppressed Ltd");
    const contact = await person(account, {
      email: "blocked@suppressed.example",
    });
    const { campaign: target } = await campaign("Suppressed campaign");
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: "blocked@suppressed.example",
      reason: "unsubscribe",
    });

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: "suppressed",
    });
  });

  it("labels a contact whose whole domain is suppressed", async () => {
    const account = await company("Domain Ltd");
    const contact = await person(account, {
      email: "someone@blockeddomain.example",
    });
    const { campaign: target } = await campaign("Domain campaign");
    await db.insert(schema.suppressionEntries).values({
      scope: "domain",
      normalizedValue: "blockeddomain.example",
      reason: "manual",
    });

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: "suppressed",
    });
  });

  // Suppression is permanent and global, so it outranks every reason a contact
  // might otherwise look available — including a sequence running elsewhere,
  // which on its own no longer excludes anybody.
  it("still suppresses a contact who is also running a sequence elsewhere", async () => {
    const account = await company("Both Ltd");
    const contact = await person(account, {
      email: "both@both-ltd.example",
    });
    const other = await campaign("Both other campaign");
    const { campaign: target } = await campaign("Both target campaign");
    const enrolled = await enrollContact(db, {
      campaignId: other.campaign.id,
      campaignVersionId: other.version.id,
      contactId: contact.id,
    });
    expect(enrolled.ok).toBe(true);
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: "both@both-ltd.example",
      reason: "unsubscribe",
    });

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: "suppressed",
    });
  });

  // The `case` arms are ordered, and the order is the precedence: enrolled
  // *here* is the answer to the question this screen asks, so it wins even
  // over a suppression. Pinned because swapping the arms is silent — the
  // counts move between two lines of the heading, and a repeated press starts
  // reporting "no longer eligible" instead of "already enrolled".
  it("names being enrolled here before a suppression", async () => {
    const account = await company("Precedence Ltd");
    const contact = await person(account, {
      email: "both-reasons@precedence.example",
    });
    const { campaign: target, version } = await campaign("Precedence campaign");
    const enrolled = await enrollContact(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      contactId: contact.id,
    });
    expect(enrolled.ok).toBe(true);
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: "both-reasons@precedence.example",
      reason: "unsubscribe",
    });

    const rows = await candidatesFor(target.id);

    expect(rows.find((row) => row.contactId === contact.id)).toMatchObject({
      ineligibility: "already_enrolled",
    });
  });

  it("filters on company name, case-insensitively", async () => {
    const wanted = await company("Groupe MOUSSET");
    const other = await company("Radiance");
    const inside = await person(wanted);
    const outside = await person(other);
    const { campaign: target } = await campaign("Company filter campaign");

    const rows = await candidatesFor(target.id, { company: "mousset" });

    const ids = rows.map((row) => row.contactId);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
  });

  it("filters on job title", async () => {
    const account = await company("Roles Ltd");
    const wanted = await person(account, {
      jobTitle: "Responsable logistique",
    });
    const other = await person(account, { jobTitle: "Directeur commercial" });
    const { campaign: target } = await campaign("Role filter campaign");

    const rows = await candidatesFor(target.id, { role: "logistique" });

    const ids = rows.map((row) => row.contactId);
    expect(ids).toContain(wanted.id);
    expect(ids).not.toContain(other.id);
  });

  it("filters on minimum confidence", async () => {
    const account = await company("Confidence Ltd");
    const strong = await person(account, { confidence: "0.950" });
    const weak = await person(account, { confidence: "0.400" });
    const { campaign: target } = await campaign("Confidence campaign");

    const rows = await candidatesFor(target.id, { minConfidence: 0.8 });

    const ids = rows.map((row) => row.contactId);
    expect(ids).toContain(strong.id);
    expect(ids).not.toContain(weak.id);
  });

  // The filter is inclusive, and which side of the boundary it falls on is
  // load-bearing: an operator setting 0.85 means "0.85 is good enough".
  it("keeps a confidence exactly equal to the minimum", async () => {
    const account = await company("Boundary Ltd");
    const exact = await person(account, { confidence: "0.800" });
    const { campaign: target } = await campaign("Boundary campaign");

    const rows = await candidatesFor(target.id, { minConfidence: 0.8 });

    expect(rows.map((row) => row.contactId)).toContain(exact.id);
  });

  // The join carries no status predicate of its own; the partial unique index
  // is what stops a contact with a rejected candidate beside their accepted
  // one from appearing twice.
  it("returns one row for a contact who also has a rejected address", async () => {
    const account = await company("History Ltd");
    const contact = await person(account, { email: "kept@history.example" });
    await db.insert(schema.emailCandidates).values({
      contactId: contact.id,
      email: "old@history.example",
      normalizedEmail: "old@history.example",
      domain: "history.example",
      confidence: "0.500",
      source: "fixture",
      status: "rejected",
    });
    const { campaign: target } = await campaign("History campaign");

    const rows = await candidatesFor(target.id);

    expect(rows.filter((row) => row.contactId === contact.id)).toHaveLength(1);
    expect(rows.find((row) => row.contactId === contact.id)?.email).toBe(
      "kept@history.example",
    );
  });

  // `%` and `_` are LIKE wildcards. An operator typing a literal one into the
  // box must not silently widen their own search.
  it("treats a per-cent sign in a filter as a character", async () => {
    const wanted = await company("100% Renewable");
    const other = await company("Ordinary Energy");
    const inside = await person(wanted);
    const outside = await person(other);
    const { campaign: target } = await campaign("Wildcard campaign");

    const rows = await candidatesFor(target.id, { company: "100%" });

    const ids = rows.map((row) => row.contactId);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
  });
});

describe("enrolling a selection trusts the database, not the browser", () => {
  async function mailbox() {
    sequence += 1;
    const [row] = await db
      .insert(schema.mailboxConnections)
      .values({
        provider: "mock",
        email: `box-${sequence}@example.com`,
        normalizedEmail: `box-${sequence}@example.com`,
        status: "available",
      })
      .returning();
    return row!;
  }

  it("enrolls every eligible contact when no selection is given", async () => {
    const account = await company("Bulk Ltd");
    const first = await person(account);
    const second = await person(account);
    const { campaign: target, version } = await campaign("Bulk campaign");
    const box = await mailbox();

    const result = await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Bulk Ltd" },
    });

    expect(result).toMatchObject({ ok: true, enrolled: 2, ignored: 0 });
    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows.map((row) => row.contactId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("enrolls only the contacts asked for", async () => {
    const account = await company("Chosen Ltd");
    const wanted = await person(account);
    await person(account);
    const { campaign: target, version } = await campaign("Chosen campaign");
    const box = await mailbox();

    const result = await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Chosen Ltd" },
      contactIds: [wanted.id],
    });

    expect(result).toMatchObject({ ok: true, enrolled: 1, ignored: 0 });
    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contactId).toBe(wanted.id);
  });

  // The load-bearing test. A checkbox is an expression of intent, not an
  // authorization: the page may have been rendered before the suppression
  // existed, or the identifier may never have been offered at all.
  it("refuses a submitted contact that is no longer eligible", async () => {
    const account = await company("Stale Ltd");
    const contact = await person(account, {
      email: "stale@stale-ltd.example",
    });
    const { campaign: target, version } = await campaign("Stale campaign");
    const box = await mailbox();
    await db.insert(schema.suppressionEntries).values({
      scope: "email",
      normalizedValue: "stale@stale-ltd.example",
      reason: "unsubscribe",
    });

    const result = await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: {},
      contactIds: [contact.id],
    });

    expect(result).toMatchObject({ ok: true, enrolled: 0, ignored: 1 });
    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses a contact identifier that was never offered", async () => {
    const { campaign: target, version } = await campaign("Foreign campaign");
    const box = await mailbox();

    const result = await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: {},
      contactIds: [crypto.randomUUID()],
    });

    expect(result).toMatchObject({ ok: true, enrolled: 0, ignored: 1 });
  });

  // The unique constraint already makes this a no-op; the point is that the
  // operator is told which of the two things happened.
  it("reports a repeat as already enrolled rather than as new", async () => {
    const account = await company("Repeat Ltd");
    const contact = await person(account);
    const { campaign: target, version } = await campaign("Repeat campaign");
    const box = await mailbox();
    const input = {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: {},
      contactIds: [contact.id],
    };

    const first = await enrollSelection(db, input);
    const second = await enrollSelection(db, input);

    expect(first).toMatchObject({ ok: true, enrolled: 1 });
    // The second pass no longer sees them as eligible, because the first
    // enrollment now exists. They are named for what they are rather than
    // lumped in with an identifier that was never offered.
    expect(second).toMatchObject({
      ok: true,
      enrolled: 0,
      alreadyEnrolled: 1,
      ignored: 0,
    });
    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows).toHaveLength(1);
  });

  /**
   * One company holding more eligible prospects than a request will write.
   *
   * Bulk-inserted in two statements rather than through `person()`, which is
   * one round trip per contact: the point of this fixture is the ceiling, and
   * five hundred sequential inserts would spend the test's time proving
   * nothing about it.
   */
  async function crowd(size: number) {
    const account = await company("Ceiling Ltd");
    sequence += 1;
    const batch = `ceiling-${sequence}`;
    const rows = await db
      .insert(schema.contacts)
      .values(
        Array.from({ length: size }, (_unused, index) => ({
          accountId: account.id,
          firstName: "Given",
          lastName: `Family ${index}`,
          fullName: `Person ${batch}-${index}`,
          normalizedFullName: `${batch}-${index}`,
          jobTitle: "Analyst",
          emailResolutionStatus: "resolved" as const,
        })),
      )
      .returning({ id: schema.contacts.id });
    await db.insert(schema.emailCandidates).values(
      rows.map((row, index) => ({
        contactId: row.id,
        email: `${batch}-${index}@ceiling.example`,
        normalizedEmail: `${batch}-${index}@ceiling.example`,
        domain: "ceiling.example",
        confidence: "0.900",
        source: "fixture",
        status: "accepted" as const,
      })),
    );
    return account;
  }

  // The one place the design lets the screen's count and the action's work
  // disagree, so it is the one that has to be measured rather than reasoned
  // about. The ceiling is read from the module: a test that hard-coded five
  // hundred would keep passing if the constant moved.
  //
  // Five hundred and one enrollments, each its own transaction, so it carries
  // its own timeout rather than inheriting the file's: this is deliberately
  // the slow test.
  it("stops at the request ceiling, says how many it left, and finishes on the next press", async () => {
    await crowd(MAXIMUM_ENROLLMENTS_PER_REQUEST + 1);
    const { campaign: target, version } = await campaign("Ceiling campaign");
    const box = await mailbox();
    const input = {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Ceiling Ltd" },
    };

    const first = await enrollSelection(db, input);
    const second = await enrollSelection(db, input);

    expect(first).toMatchObject({
      ok: true,
      enrolled: MAXIMUM_ENROLLMENTS_PER_REQUEST,
      truncated: 1,
      failed: 0,
    });
    // "run it again" is what the notice promises, so the second press is
    // part of the same behaviour: the first five hundred have become
    // ineligible, leaving exactly the one that was left over. It reports no
    // `alreadyEnrolled`, because asking for every eligible row never asked
    // for them.
    expect(second).toMatchObject({
      ok: true,
      enrolled: 1,
      truncated: 0,
      alreadyEnrolled: 0,
    });
    const rows = await db
      .select({ id: schema.enrollments.id })
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows).toHaveLength(MAXIMUM_ENROLLMENTS_PER_REQUEST + 1);
  }, 30_000);

  it("refuses every enrollment when the version is not published", async () => {
    const account = await company("Draft Ltd");
    await person(account);
    sequence += 1;
    const [draftCampaign] = await db
      .insert(schema.campaigns)
      .values({
        name: `Draft ${sequence}`,
        type: "commercial_outreach",
        status: "draft",
        targetDescription: "Not published yet",
      })
      .returning();
    const [draftVersion] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: draftCampaign!.id, version: 1 })
      .returning();
    const box = await mailbox();

    const result = await enrollSelection(db, {
      campaignId: draftCampaign!.id,
      campaignVersionId: draftVersion!.id,
      mailboxId: box.id,
      filters: { company: "Draft Ltd" },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "VERSION_NOT_PUBLISHED",
    });
    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, draftCampaign!.id));
    expect(rows).toHaveLength(0);
  });

  it("queues the first message for every contact it enrolled", async () => {
    const account = await company("Queued Ltd");
    await person(account);
    await person(account);
    const { campaign: target, version } = await campaign("Queued campaign");
    const box = await mailbox();

    await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Queued Ltd" },
    });

    const enrolled = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(enrolled).toHaveLength(2);
    const commands = await db.select().from(schema.operatorCommands);
    for (const row of enrolled) {
      expect(
        commands.filter(
          (command) =>
            command.command === "generate-message" &&
            (command.payload as { enrollmentId?: string }).enrollmentId ===
              row.id,
        ),
      ).toHaveLength(1);
    }
  });

  // The screen only ever offered available mailboxes, but a page is a
  // photograph: a token can expire while it is open. Writing the cohort anyway
  // would point every row at a mailbox the send policy permanently refuses.
  it("refuses the whole cohort when the mailbox stopped being available", async () => {
    const account = await company("Revoked Ltd");
    await person(account);
    await person(account);
    const { campaign: target, version } = await campaign("Revoked campaign");
    const box = await mailbox();
    await db
      .update(schema.mailboxConnections)
      .set({ status: "revoked" })
      .where(eq(schema.mailboxConnections.id, box.id));

    const result = await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Revoked Ltd" },
    });

    expect(result).toMatchObject({ ok: false, code: "MAILBOX_UNAVAILABLE" });
    expect(
      await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.campaignId, target.id)),
    ).toHaveLength(0);
  });

  it("carries the chosen mailbox onto every enrollment", async () => {
    const account = await company("Mailbox Ltd");
    await person(account);
    const { campaign: target, version } = await campaign("Mailbox campaign");
    const box = await mailbox();

    await enrollSelection(db, {
      campaignId: target.id,
      campaignVersionId: version.id,
      mailboxId: box.id,
      filters: { company: "Mailbox Ltd" },
    });

    const rows = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.campaignId, target.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxId).toBe(box.id);
  });
});
