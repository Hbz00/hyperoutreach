import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";

// `route.ts` reaches `@/lib/db/client`, which imports the real `server-only`
// package — an unconditional throw outside a Next.js react-server bundle. The
// same shadowing trick the other route tests use.
vi.mock("server-only", () => ({}));

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

// Set before the route is imported: `getDatabase()` reads `DATABASE_URL` when
// it first opens a connection.
process.env.DATABASE_URL = testUrl;
process.env.OPERATOR_EMAIL = "operator@enroll.example";
process.env.OPERATOR_PASSWORD = "at-least-twelve-characters";
process.env.SESSION_SECRET = "s".repeat(32);
// The route asks for a maintenance cycle after a successful enrollment. This
// is the explicit opt-out that path honours, and it keeps `after()` — which
// needs a request scope this test does not have — out of the way.
process.env.LOCAL_MAINTENANCE_ENABLED = "false";

const { POST } = await import("@/app/api/operator/commands/[command]/route");
const { createOperatorSession, OPERATOR_SESSION_COOKIE } =
  await import("@/lib/operator-auth");

const NOW = new Date("2026-08-18T09:00:00.000Z");

let sequence = 0;

async function fixture(options: { people?: number } = {}) {
  sequence += 1;
  const suffix = `${sequence}`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "mock",
      email: `box-${suffix}@example.com`,
      normalizedEmail: `box-${suffix}@example.com`,
      status: "available",
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `Route ${suffix}`, normalizedName: `route-${suffix}` })
    .returning();
  const contacts = [];
  for (let index = 0; index < (options.people ?? 2); index += 1) {
    const [contact] = await db
      .insert(schema.contacts)
      .values({
        accountId: account!.id,
        firstName: "Ada",
        lastName: `Person ${suffix}-${index}`,
        fullName: `Ada Person ${suffix}-${index}`,
        normalizedFullName: `ada-${suffix}-${index}`,
        jobTitle: "Analyst",
        emailResolutionStatus: "resolved",
      })
      .returning();
    const email = `ada-${suffix}-${index}@route-${suffix}.example`;
    await db.insert(schema.emailCandidates).values({
      contactId: contact!.id,
      email,
      normalizedEmail: email,
      domain: `route-${suffix}.example`,
      confidence: "0.900",
      source: "fixture",
      status: "accepted",
    });
    contacts.push(contact!);
  }
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Route ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Route level enrollment fixture",
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
  const [published] = await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id))
    .returning();
  return {
    mailbox: mailbox!,
    account: account!,
    contacts,
    campaign: campaign!,
    version: published!,
  };
}

async function enroll(
  fields: Record<string, string>,
  contactIds: string[] = [],
): Promise<{ status: number; location: string | null; notice: string | null }> {
  const { token, session } = createOperatorSession(process.env);
  const formData = new FormData();
  formData.set("csrf", session.csrfToken);
  for (const [key, fieldValue] of Object.entries(fields)) {
    formData.set(key, fieldValue);
  }
  for (const contactId of contactIds) formData.append("contactId", contactId);
  const response = await POST(
    new Request("http://operator.local/api/operator/commands/enroll-contacts", {
      method: "POST",
      body: formData,
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    }),
    { params: Promise.resolve({ command: "enroll-contacts" }) },
  );
  const location = response.headers.get("location");
  return {
    status: response.status,
    location,
    notice: location
      ? new URL(location, "http://operator.local").searchParams.get("notice")
      : null,
  };
}

async function enrollmentsFor(campaignId: string) {
  return db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.campaignId, campaignId));
}

beforeAll(async () => {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await client.end();
});

describe("the enroll-contacts command", () => {
  it("enrolls the checked prospects", async () => {
    const context = await fixture({ people: 3 });

    const result = await enroll(
      {
        campaignId: context.campaign.id,
        campaignVersionId: context.version.id,
        mailboxId: context.mailbox.id,
        scope: "selected",
      },
      [context.contacts[0]!.id, context.contacts[1]!.id],
    );

    expect(result.status).toBe(303);
    expect(result.notice).toContain("2 prospects enrolled");
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(2);
  });

  it("enrolls everything the filter matches when asked for the filter", async () => {
    const context = await fixture({ people: 3 });

    const result = await enroll({
      campaignId: context.campaign.id,
      campaignVersionId: context.version.id,
      mailboxId: context.mailbox.id,
      scope: "filtered",
      company: context.account.name,
    });

    expect(result.notice).toContain("3 prospects enrolled");
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(3);
  });

  // The checkboxes are ignored entirely on the filtered scope: the button says
  // "all eligible", so sending one tick must not narrow it to one.
  it("ignores the checkboxes on the filtered scope", async () => {
    const context = await fixture({ people: 3 });

    await enroll(
      {
        campaignId: context.campaign.id,
        campaignVersionId: context.version.id,
        mailboxId: context.mailbox.id,
        scope: "filtered",
        company: context.account.name,
      },
      [context.contacts[0]!.id],
    );

    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(3);
  });

  it("refuses a contact identifier the filter never offered", async () => {
    const context = await fixture({ people: 1 });
    const other = await fixture({ people: 1 });

    const result = await enroll(
      {
        campaignId: context.campaign.id,
        campaignVersionId: context.version.id,
        mailboxId: context.mailbox.id,
        scope: "selected",
        company: context.account.name,
      },
      [other.contacts[0]!.id],
    );

    expect(result.notice).toContain("Nothing enrolled");
    expect(result.notice).toContain("1 no longer eligible");
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(0);
  });

  it("refuses to enroll without a mailbox", async () => {
    const context = await fixture({ people: 1 });

    const result = await enroll(
      {
        campaignId: context.campaign.id,
        campaignVersionId: context.version.id,
        scope: "selected",
      },
      [context.contacts[0]!.id],
    );

    expect(result.notice).toContain("mailbox");
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(0);
  });

  it("says so when nothing was ticked", async () => {
    const context = await fixture({ people: 1 });

    const result = await enroll({
      campaignId: context.campaign.id,
      campaignVersionId: context.version.id,
      mailboxId: context.mailbox.id,
      scope: "selected",
    });

    expect(result.notice).toContain("No prospect selected");
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(0);
  });

  it("returns to the same filtered screen", async () => {
    const context = await fixture({ people: 1 });

    const result = await enroll(
      {
        campaignId: context.campaign.id,
        campaignVersionId: context.version.id,
        mailboxId: context.mailbox.id,
        scope: "selected",
        company: context.account.name,
        role: "Analyst",
      },
      [context.contacts[0]!.id],
    );

    const url = new URL(result.location!, "http://operator.local");
    expect(url.pathname).toBe(`/campaigns/${context.campaign.id}/enroll`);
    expect(url.searchParams.get("company")).toBe(context.account.name);
    expect(url.searchParams.get("role")).toBe("Analyst");
  });

  it("refuses every enrollment while the version is a draft", async () => {
    sequence += 1;
    const [draftCampaign] = await db
      .insert(schema.campaigns)
      .values({
        name: `Draft route ${sequence}`,
        type: "commercial_outreach",
        status: "draft",
        targetDescription: "Not published",
      })
      .returning();
    const [draftVersion] = await db
      .insert(schema.campaignVersions)
      .values({ campaignId: draftCampaign!.id, version: 1 })
      .returning();
    const context = await fixture({ people: 1 });

    const result = await enroll(
      {
        campaignId: draftCampaign!.id,
        campaignVersionId: draftVersion!.id,
        mailboxId: context.mailbox.id,
        scope: "selected",
      },
      [context.contacts[0]!.id],
    );

    expect(result.notice).toContain("not published");
    expect(await enrollmentsFor(draftCampaign!.id)).toHaveLength(0);
  });

  it("rejects a request without the session's CSRF token", async () => {
    const context = await fixture({ people: 1 });
    const { token } = createOperatorSession(process.env);
    const formData = new FormData();
    formData.set("csrf", "wrong-token");
    formData.set("campaignId", context.campaign.id);
    formData.set("campaignVersionId", context.version.id);
    formData.set("mailboxId", context.mailbox.id);
    formData.set("scope", "filtered");

    const response = await POST(
      new Request(
        "http://operator.local/api/operator/commands/enroll-contacts",
        {
          method: "POST",
          body: formData,
          headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
        },
      ),
      { params: Promise.resolve({ command: "enroll-contacts" }) },
    );

    expect(response.status).toBe(403);
    expect(await enrollmentsFor(context.campaign.id)).toHaveLength(0);
  });
});
