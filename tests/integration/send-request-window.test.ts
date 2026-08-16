import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import {
  findStaleRecoveryCandidates,
  releaseExpiredSendRequests,
  SEND_COMPLETION_WINDOW_MS,
} from "@/modules/workflows/recovery-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

type MessageOverrides = Partial<typeof schema.messages.$inferInsert>;

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
    .values({ name: `Window ${suffix}`, normalizedName: `window-${suffix}` })
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
      name: `Window ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Bound the delay between a send request and delivery",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
    .returning();
  // Steps are immutable once the version is published, so they go in first.
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
  return {
    mailbox: mailbox!,
    account: account!,
    contact: contact!,
    enrollment: enrollment!,
    async message(overrides: MessageOverrides = {}) {
      const [row] = await db
        .insert(schema.messages)
        .values({
          enrollmentId: enrollment!.id,
          mailboxId: mailbox!.id,
          stepIndex: overrides.stepIndex ?? 0,
          direction: "outbound",
          outreachId: `out_${crypto.randomUUID()}`,
          subject: "Hello Ada",
          body: "A note for Window",
          recipient: `ada-${crypto.randomUUID()}@example.com`,
          contactAccountId: account!.id,
          employmentVersion: contact!.employmentVersion,
          status: "approved",
          ...overrides,
        })
        .returning();
      return row!;
    },
  };
}

async function readMessage(id: string) {
  const [row] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return row!;
}

async function permissiveSendingSettings(
  overrides: Parameters<typeof updateOperatorSendingSettings>[1] extends infer T
    ? Partial<T>
    : never = {},
) {
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

describe("send request window", () => {
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
    await permissiveSendingSettings();
  });

  it("recovers a drafted message whose send request is inside the window", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
    });

    const candidates = await findStaleRecoveryCandidates(db, {
      now: NOW,
      messageLimit: 200,
    });

    expect(candidates.messageIds).toContain(message.id);
  });

  it("stops recovering a drafted message once its send request has expired", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(
        NOW.getTime() - SEND_COMPLETION_WINDOW_MS - 1_000,
      ),
    });

    const candidates = await findStaleRecoveryCandidates(db, {
      now: NOW,
      messageLimit: 200,
    });

    expect(candidates.messageIds).not.toContain(message.id);
  });

  it("never recovers a drafted message nobody asked to send", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: null,
    });

    const candidates = await findStaleRecoveryCandidates(db, {
      now: NOW,
      messageLimit: 200,
    });

    expect(candidates.messageIds).not.toContain(message.id);
  });

  it("hands an expired request back to the operator, keeping the provider draft", async () => {
    const fixture = await seed();
    const draftId = `draft_${crypto.randomUUID()}`;
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: draftId,
      sendRequestedAt: new Date(
        NOW.getTime() - SEND_COMPLETION_WINDOW_MS - 1_000,
      ),
    });

    const released = await releaseExpiredSendRequests(db, { now: NOW });

    expect(released).toContain(message.id);
    const stored = await readMessage(message.id);
    expect(stored).toMatchObject({
      status: "approved",
      providerDraftId: draftId,
      sendRequestedAt: null,
    });
    expect(stored.lastError).toBeTruthy();
    const [transition] = await db
      .select()
      .from(schema.stateTransitions)
      .where(
        and(
          eq(schema.stateTransitions.entityId, message.id),
          eq(schema.stateTransitions.toState, "approved"),
        ),
      );
    expect(transition).toBeTruthy();
  });

  it("hands a drafted message with no send request back on the first tick that sees it", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: null,
    });

    await releaseExpiredSendRequests(db, { now: NOW });

    expect(await readMessage(message.id)).toMatchObject({
      status: "approved",
    });
  });

  it("leaves a live request alone", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
    });

    await releaseExpiredSendRequests(db, { now: NOW });

    expect(await readMessage(message.id)).toMatchObject({ status: "drafted" });
  });

  it("stamps the send request when the claim starts from approved, and not when it resumes", async () => {
    const fixture = await seed();
    const requested = await fixture.message({ status: "approved" });
    const resumed = await fixture.message({
      stepIndex: 1,
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: null,
    });

    const provider = new DatabaseMockMailProvider(db);
    await sendApprovedMessage(db, provider, { messageId: requested.id });
    await sendApprovedMessage(db, provider, { messageId: resumed.id });

    expect((await readMessage(requested.id)).sendRequestedAt).toBeInstanceOf(
      Date,
    );
    expect((await readMessage(resumed.id)).sendRequestedAt).toBeNull();
  });

  // The criterion the first design draft would have failed. `draftedAt` is
  // stamped once and never refreshed, so a window read from it is already
  // expired at the moment of the second click. The clock has to be the request.
  it("keeps a second send gesture recoverable for a full window", async () => {
    const fixture = await seed();
    const message = await fixture.message({ status: "approved" });
    const provider = new DatabaseMockMailProvider(db);

    // First gesture, refused by the final policy check: 17:59 passes the
    // pre-claim check, 18:01 fails the one taken just before sending.
    await permissiveSendingSettings({ workingEndMinute: 1_080 });
    const firstGesture = [
      new Date("2026-08-16T17:59:00.000Z"),
      new Date("2026-08-16T18:01:00.000Z"),
      new Date("2026-08-16T18:01:00.000Z"),
    ];
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: message.id },
        {
          clock: () =>
            firstGesture.shift() ?? new Date("2026-08-16T18:01:00.000Z"),
        },
      ),
    ).toMatchObject({ ok: false, code: "OUTSIDE_WORKING_HOURS" });
    const blocked = await readMessage(message.id);
    expect(blocked.status).toBe("drafted");
    const firstDraftedAt = blocked.draftedAt;

    // Next morning: the request has expired, so it comes back to the operator.
    const nextMorning = new Date("2026-08-17T09:00:00.000Z");
    await releaseExpiredSendRequests(db, { now: nextMorning });
    expect(await readMessage(message.id)).toMatchObject({ status: "approved" });

    // Second gesture. `draftedAt` has not moved — which is exactly why it
    // cannot be the clock — but the message must be recoverable again.
    await permissiveSendingSettings();
    await sendApprovedMessage(
      db,
      provider,
      { messageId: message.id },
      { clock: () => nextMorning },
    );
    const afterSecond = await readMessage(message.id);
    expect(afterSecond.draftedAt).toEqual(firstDraftedAt);
    expect(afterSecond.sendRequestedAt).toEqual(nextMorning);
  });

  it("writes the refusal on the message when a send is blocked before the claim", async () => {
    const fixture = await seed();
    const message = await fixture.message({ status: "approved" });
    await permissiveSendingSettings({ emergencyPause: true });

    expect(
      await sendApprovedMessage(
        db,
        new DatabaseMockMailProvider(db),
        { messageId: message.id },
        { clock: () => NOW },
      ),
    ).toMatchObject({ ok: false, code: "EMERGENCY_PAUSED" });

    const stored = await readMessage(message.id);
    expect(stored.status).toBe("approved");
    expect(stored.lastError).toContain("EMERGENCY_PAUSED");
  });

  it("serves the next actionable message once the oldest one keeps being refused", async () => {
    const fixture = await seed();
    const oldest = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    const younger = await fixture.message({
      stepIndex: 1,
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 1_800_000),
    });

    const firstTick = await findStaleRecoveryCandidates(db, {
      now: NOW,
      messageLimit: 2,
    });
    expect(firstTick.messageIds).toEqual([oldest.id]);

    // The refusal is what rotates the lane: it is the only write the blocked
    // path makes, and the database trigger turns it into a fresh `updated_at`.
    await permissiveSendingSettings({ emergencyPause: true });
    await sendApprovedMessage(
      db,
      new DatabaseMockMailProvider(db),
      { messageId: oldest.id },
      { clock: () => NOW },
    );
    await permissiveSendingSettings();

    const secondTick = await findStaleRecoveryCandidates(db, {
      now: NOW,
      messageLimit: 2,
    });
    expect(secondTick.messageIds).toEqual([younger.id]);
  });

  // The incident, version two. Version one was "an approval was enough to
  // send"; this is "a send gesture the policy refused was enough to send,
  // sixteen hours later". A full maintenance round must hand the message back
  // instead of delivering it the moment the window reopens.
  it("does not deliver a refused send when the window reopens the next morning", async () => {
    const fixture = await seed();
    const message = await fixture.message({ status: "approved" });
    const provider = new DatabaseMockMailProvider(db);

    await permissiveSendingSettings({ workingEndMinute: 1_080 });
    const gesture = [
      new Date("2026-08-16T17:59:00.000Z"),
      new Date("2026-08-16T18:01:00.000Z"),
      new Date("2026-08-16T18:01:00.000Z"),
    ];
    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: message.id },
        {
          clock: () => gesture.shift() ?? new Date("2026-08-16T18:01:00.000Z"),
        },
      ),
    ).toMatchObject({ ok: false, code: "OUTSIDE_WORKING_HOURS" });
    expect((await readMessage(message.id)).status).toBe("drafted");

    // Next morning, sending is allowed again. Nothing about the policy stands
    // in the way any more — only the expiry of the request does.
    //
    // Item 5 later added a sanctioned way to cross this night: an operator who
    // asks for the next legal slot gets an intent, and the lane dispatches it
    // in the morning under a *fresh* request clock. That is not this test. Here
    // the operator asked once, at 17:59, and nothing was scheduled — so the
    // delay between that gesture and any delivery stays bounded by the window,
    // which is what the criterion says and what this asserts.
    await permissiveSendingSettings();
    const services = createWorkflowTaskServices(db, {});
    const round = (await services["recover-stale-work"]({
      observedAt: new Date("2026-08-17T09:00:00.000Z").toISOString(),
      limit: 1,
    })) as { sendRequestsReleased: string[] };

    expect(round.sendRequestsReleased).toContain(message.id);
    const stored = await readMessage(message.id);
    expect(stored).toMatchObject({
      status: "approved",
      sentAt: null,
      attemptCount: 0,
      sendRequestedAt: null,
    });
  });

  it("hands back an unrequested draft within the round, not a tick later", async () => {
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: null,
    });

    const services = createWorkflowTaskServices(db, {});
    const round = (await services["recover-stale-work"]({
      observedAt: NOW.toISOString(),
      limit: 1,
    })) as { sendRequestsReleased: string[] };

    expect(round.sendRequestsReleased).toContain(message.id);
    expect(await readMessage(message.id)).toMatchObject({
      status: "approved",
      sentAt: null,
    });
  });

  // The recovery stage runs third in the maintenance cycle, and its `now` is
  // the instant the tick started — stale by however long inbound and follow-ups
  // took. For most of that stage a late clock only makes the work late. Not
  // here: completing a stuck request is a delivery, and a delivery judged
  // against a window that has since shut is an email leaving after hours with
  // nobody watching, which is the one thing this product may never do. The
  // window's own expiry bounds *how long* a request may still be completed; the
  // policy decides *whether* it may, and it has to be asked about now.
  //
  // Built from the wall clock rather than a calendar date so it means the same
  // thing whenever the suite runs: a one-hour window around a tick six hours
  // old cannot contain the present, wherever in the day the present is.
  it("judges a recovered send on the wall clock, not on the instant the tick started", async () => {
    const wallClock = new Date();
    const observedAt = new Date(wallClock.getTime() - 6 * 60 * 60_000);
    const minuteOfDay =
      observedAt.getUTCHours() * 60 + observedAt.getUTCMinutes();
    await permissiveSendingSettings({
      timezone: "UTC",
      workingStartMinute: Math.max(0, minuteOfDay - 5),
      workingEndMinute: Math.min(24 * 60, minuteOfDay + 5),
    });
    const fixture = await seed();
    const message = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      // Inside the completion window as measured from the tick, so the stage
      // genuinely selects it. Only the clock the policy is asked on is at issue.
      sendRequestedAt: new Date(observedAt.getTime() - 60_000),
    });

    const services = createWorkflowTaskServices(db, {});
    await services["recover-stale-work"]({
      observedAt: observedAt.toISOString(),
      limit: 5,
    });

    const stored = await readMessage(message.id);
    expect(stored.sentAt).toBeNull();
    expect(stored.status).not.toBe("sent");
    // The refusal, not a provider outcome. Judged on the tick's instant this
    // reached the provider and came back with a transport error instead —
    // which is only a mock away from a delivered email.
    expect(stored.lastError).toContain("OUTSIDE_WORKING_HOURS");
    expect(stored.attemptCount).toBe(0);
  });

  it("orders the actionable lane on the marker the database owns", async () => {
    const fixture = await seed();
    const first = await fixture.message({
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
    });
    const second = await fixture.message({
      stepIndex: 1,
      status: "drafted",
      providerDraftId: `draft_${crypto.randomUUID()}`,
      sendRequestedAt: new Date(NOW.getTime() - 60_000),
    });

    // Any UPDATE moves a row to the back of the lane, because the trigger owns
    // `updated_at`. Writing a value would be discarded.
    await db
      .update(schema.messages)
      .set({ lastError: "rotated" })
      .where(eq(schema.messages.id, first.id));

    const rows = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.enrollmentId, fixture.enrollment.id))
      .orderBy(asc(schema.messages.updatedAt), asc(schema.messages.id));
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
  });
});
