import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { updateOperatorSendingSettings } from "@/modules/settings/service";

// `route.ts` reaches `@/lib/db/client`, which imports the real `server-only`
// package — an unconditional throw outside a Next.js react-server bundle. The
// same shadowing trick the other route test uses.
vi.mock("server-only", () => ({}));

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

// Set before the route is imported: `getDatabase()` reads `DATABASE_URL` when
// it first opens a connection, and this is the one place in the integration
// suite that lets production code choose its own database. Pointing it at the
// disposable one is the whole reason the real handler can be driven here.
process.env.DATABASE_URL = testUrl;
process.env.OPERATOR_EMAIL = "operator@schedule.example";
process.env.OPERATOR_PASSWORD = "at-least-twelve-characters";
process.env.SESSION_SECRET = "s".repeat(32);

const { POST } = await import("@/app/api/operator/commands/[command]/route");
const { createOperatorSession, OPERATOR_SESSION_COOKIE } =
  await import("@/lib/operator-auth");

/** Monday 2026-08-17, 14:00 Paris — well inside the working window. */
const MONDAY_AFTERNOON = new Date("2026-08-17T12:00:00.000Z");

let sequence = 0;

async function settings(overrides: Record<string, unknown> = {}) {
  const result = await updateOperatorSendingSettings(db, {
    emergencyPause: false,
    timezone: "Europe/Paris",
    workingDays: [1, 2, 3, 4, 5],
    workingStartMinute: 9 * 60,
    workingEndMinute: 18 * 60,
    mailboxDailyCap: 100,
    campaignDailyCap: 100,
    mailboxMinimumDelaySeconds: 60,
    // The shipped default, and what the live installation carries. It is the
    // value that made the click die: a day counted from the click ends on the
    // very instant the button promised.
    contactMinimumDelayMinutes: 24 * 60,
    crossCampaignCooldownDays: 0,
    ...overrides,
    actor: "operator",
  } as Parameters<typeof updateOperatorSendingSettings>[1]);
  if (!result.ok) throw new Error(result.code);
}

async function seed(options: { priorSentAt?: Date } = {}) {
  sequence += 1;
  const suffix = `${sequence}-${crypto.randomUUID().slice(0, 8)}`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "mock",
      email: `op-${suffix}@example.com`,
      normalizedEmail: `op-${suffix}@example.com`,
      status: "available",
    })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `Route ${suffix}`, normalizedName: `route-${suffix}` })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      normalizedFullName: `ada-${suffix}`,
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Route ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "schedule a send from the review card",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
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
      delayMinutes: 0,
      subjectTemplate: "Following up, {{first_name}}",
      bodyTemplate: "A second note for {{company}}",
    },
  ]);
  await db
    .update(schema.campaignVersions)
    .set({ publishedAt: MONDAY_AFTERNOON })
    .where(eq(schema.campaignVersions.id, version!.id));
  const [enrollment] = await db
    .insert(schema.enrollments)
    .values({
      campaignId: campaign!.id,
      campaignVersionId: version!.id,
      contactId: contact!.id,
      mailboxId: mailbox!.id,
      state: "approved",
      // Step 0 has gone out; step 1 is the one awaiting review. This is the
      // ordinary follow-up, and the only shape a contact delay ever refuses.
      currentStep: 1,
    })
    .returning();
  const [message] = await db
    .insert(schema.messages)
    .values({
      enrollmentId: enrollment!.id,
      mailboxId: mailbox!.id,
      stepIndex: 1,
      direction: "outbound",
      outreachId: `out_${suffix}`,
      subject: "Following up, Ada",
      body: "A second note",
      recipient: `ada-${suffix}@example.com`,
      contactAccountId: account!.id,
      employmentVersion: contact!.employmentVersion,
      status: "approved",
    })
    .returning();
  if (options.priorSentAt) {
    // Step 0, already delivered a moment ago. That send is what a 24-hour
    // contact delay refuses the next one against, and it is measured from the
    // last real activity rather than from the settings ceiling.
    await db.insert(schema.messages).values({
      enrollmentId: enrollment!.id,
      mailboxId: mailbox!.id,
      stepIndex: 0,
      direction: "outbound",
      outreachId: `prior_${suffix}`,
      subject: "Hello Ada",
      body: "A note",
      recipient: `ada-${suffix}@example.com`,
      contactAccountId: account!.id,
      employmentVersion: contact!.employmentVersion,
      status: "sent",
      sentAt: options.priorSentAt,
    });
  }
  return { message: message!, contact: contact!, mailbox: mailbox! };
}

async function clickSchedule(
  messageId: string,
): Promise<{ status: number; notice: string | null }> {
  const { token, session } = createOperatorSession(process.env);
  const formData = new FormData();
  formData.set("csrf", session.csrfToken);
  formData.set("messageId", messageId);
  const response = await POST(
    new Request("http://operator.local/api/operator/commands/schedule-send", {
      method: "POST",
      body: formData,
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    }),
    { params: Promise.resolve({ command: "schedule-send" }) },
  );
  const location = response.headers.get("location");
  return {
    status: response.status,
    notice: location
      ? new URL(location, "http://operator.local").searchParams.get("notice")
      : null,
  };
}

// The review card's Schedule button, driven through the handler the browser
// actually posts to. Everything else about this lane is exercised by calling
// its modules directly, which proves the rules and not the wiring — and the
// wiring is where this defect lived twice: the button named an instant, and
// the intent it wrote could not live to it.
describe("the Schedule button, through the route", () => {
  beforeAll(async () => {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await settings();
  });

  it("writes an intent that can outlive the wait the card is offering", async () => {
    const seeded = await seed({ priorSentAt: new Date() });

    const clickedAt = Date.now();
    const result = await clickSchedule(seeded.message.id);
    expect(result.status).toBe(303);

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, seeded.message.id));
    expect(stored!.scheduledAt).not.toBeNull();
    // The point of the whole fix. Counted from the click, the intent expired on
    // the very instant the delay cleared, and the lane gave up five minutes
    // before the only look that could have sent it. The deadline has to sit
    // beyond the wait the operator was shown, not on it.
    expect(stored!.sendIntentExpiresAt!.getTime()).toBeGreaterThan(
      clickedAt + 24 * 60 * 60_000 + 60 * 60_000,
    );
  });

  // The other half: a refusal the calendar answers is not lengthened by this,
  // and a click that lands nothing must not silently write an intent either.
  it("leaves a message no intent can be written for alone", async () => {
    const seeded = await seed();
    await db
      .update(schema.messages)
      .set({ status: "drafted" })
      .where(eq(schema.messages.id, seeded.message.id));

    const result = await clickSchedule(seeded.message.id);

    expect(result.status).toBe(303);
    expect(result.notice).toContain("no longer waiting to be sent");
    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, seeded.message.id));
    expect(stored!.scheduledAt).toBeNull();
  });
});
