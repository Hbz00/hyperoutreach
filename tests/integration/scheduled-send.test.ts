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
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import {
  AUTOMATIC_INTENT_LIFETIME_MS,
  cancelSendIntent,
  dispatchScheduledSends,
  nextLegalSendInstant,
  operatorIntentLifetimeMs,
  scheduleSendIntent,
} from "@/modules/messages/scheduled-send";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import { readScheduledSends } from "@/modules/workflows/outbound-today";
import { findStaleRecoveryCandidates } from "@/modules/workflows/recovery-service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

/** Friday 2026-08-14, 18:05 Paris — five minutes after the window shuts. */
const FRIDAY_EVENING = new Date("2026-08-14T16:05:00.000Z");
/** Monday 2026-08-17, 09:00 Paris. */
const MONDAY_MORNING = new Date("2026-08-17T07:00:00.000Z");

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
    mailboxMinimumDelaySeconds: 0,
    contactMinimumDelayMinutes: 0,
    crossCampaignCooldownDays: 0,
    ...overrides,
    actor: "operator",
  } as Parameters<typeof updateOperatorSendingSettings>[1]);
  if (!result.ok) throw new Error(result.code);
}

async function seed(
  overrides: Partial<typeof schema.messages.$inferInsert> = {},
) {
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
    .values({ name: `Slot ${suffix}`, normalizedName: `slot-${suffix}` })
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
      name: `Slot ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "send at the next legal slot",
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
    .set({ publishedAt: FRIDAY_EVENING })
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
      outreachId: `out_${suffix}`,
      subject: "Hello Ada",
      body: "A note",
      recipient: `ada-${suffix}@example.com`,
      contactAccountId: account!.id,
      employmentVersion: contact!.employmentVersion,
      status: "approved",
      ...overrides,
    })
    .returning();
  return { message: message!, enrollment: enrollment! };
}

async function read(id: string) {
  const [row] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return row!;
}

describe("sending at the next legal slot", () => {
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
    await settings();
    // Each test is about its own message. Intents left standing by an earlier
    // one would be picked up by the lane and drown the assertion.
    await db
      .update(schema.messages)
      .set({ scheduledAt: null, sendIntentExpiresAt: null });
  });

  // The whole safety of this lane rests here. A message the operator merely
  // approved carries no intent, and no worker path may send it — that is the
  // 2026-08-14 incident, and it stays closed.
  it("never touches a message that was only approved", async () => {
    const seeded = await seed();

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async () => {
        throw new Error("a merely approved message must never be sent");
      },
      { now: MONDAY_MORNING },
    );

    expect(outcomes).toEqual([]);
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: null,
      sentAt: null,
    });
  });

  it("keeps stale-work recovery blind to a scheduled message", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    const candidates = await findStaleRecoveryCandidates(db, {
      now: MONDAY_MORNING,
      messageLimit: 10,
      limit: 10,
    });

    expect(candidates.messageIds).not.toContain(seeded.message.id);
  });

  // The case that made "add a day" wrong.
  it("waits for Monday, not for tomorrow", async () => {
    const seeded = await seed();

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    expect(scheduled).toMatchObject({ ok: true, scheduledAt: MONDAY_MORNING });
    const stored = await read(seeded.message.id);
    expect(stored.scheduledAt).toEqual(MONDAY_MORNING);
    // The lifetime is counted from the opening, not from the click: counted
    // from Friday it would have run out over the weekend without a single
    // legal instant having passed.
    expect(stored.sendIntentExpiresAt!.getTime()).toBe(
      MONDAY_MORNING.getTime() + 24 * 60 * 60_000,
    );
  });

  it("does not fire before its instant", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async () => {
        throw new Error("fired before the window opened");
      },
      // Saturday.
      { now: new Date("2026-08-15T09:00:00.000Z") },
    );

    expect(outcomes).toEqual([]);
  });

  it("sends when the instant comes and the policy agrees", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });
    const sentIds: string[] = [];

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async (id) => {
        sentIds.push(id);
        return { ok: true };
      },
      { now: MONDAY_MORNING },
    );

    expect(sentIds).toEqual([seeded.message.id]);
    expect(outcomes).toEqual([
      { messageId: seeded.message.id, disposition: "sent" },
    ]);
  });

  // A refusal that time lifts costs a read and a timestamp, nothing else.
  // Without this a message scheduled at 18:00 would write an audit row a
  // minute until 09:00.
  it("waits again without recording an attempt when the refusal is transient", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });
    const eventsBefore = await db.select().from(schema.workflowEvents);

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code: "MAILBOX_MINIMUM_DELAY" }),
      async () => {
        throw new Error("a refused send must not be attempted");
      },
      { now: MONDAY_MORNING },
    );

    expect(outcomes).toEqual([
      {
        messageId: seeded.message.id,
        disposition: "waiting",
        reason: "MAILBOX_MINIMUM_DELAY",
      },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored.scheduledAt!.getTime()).toBe(
      MONDAY_MORNING.getTime() + 5 * 60_000,
    );
    expect(stored.sendIntentExpiresAt).not.toBeNull();
    expect(await db.select().from(schema.workflowEvents)).toHaveLength(
      eventsBefore.length,
    );
  });

  // Waiting cannot turn these into a send, so the intent is dropped and the
  // operator told, rather than retried until it expires.
  it.each([
    "EMERGENCY_PAUSED",
    "REPLY_PENDING",
    "UNSUBSCRIBED",
    "RECENT_CONTACT_COOLDOWN",
  ])("gives up on a %s refusal and says so", async (code) => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code }),
      async () => {
        throw new Error("a permanently refused send must not be attempted");
      },
      { now: MONDAY_MORNING },
    );

    expect(outcomes).toEqual([
      { messageId: seeded.message.id, disposition: "abandoned", reason: code },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored).toMatchObject({ status: "approved", scheduledAt: null });
    expect(stored.sendIntentExpiresAt).toBeNull();
    expect(stored.lastError).toContain(code);
  });

  it("expires an intent the policy never let through", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async () => {
        throw new Error("an expired intent must not be sent");
      },
      // Two days past the opening, so past the lifetime.
      { now: new Date("2026-08-19T07:00:00.000Z") },
    );

    expect(outcomes).toEqual([
      { messageId: seeded.message.id, disposition: "expired" },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored).toMatchObject({ status: "approved", scheduledAt: null });
    expect(stored.lastError).toContain("expired");
  });

  // The settings API refuses an empty calendar, so this writes the row
  // directly: the point is that the lane fails closed on a state it cannot
  // reach through the front door, rather than writing an intent that could
  // only ever expire.
  it("refuses to schedule against a calendar that never opens", async () => {
    const seeded = await seed();
    await db
      .update(schema.operatorSendingSettings)
      .set({ workingDays: [] })
      .where(eq(schema.operatorSendingSettings.id, 1));

    expect(
      await scheduleSendIntent(db, {
        messageId: seeded.message.id,
        now: FRIDAY_EVENING,
      }),
    ).toEqual({ ok: false, code: "NO_WORKING_SLOT" });
    expect((await read(seeded.message.id)).scheduledAt).toBeNull();
  });

  // The race the design gives up on deliberately: a send refused at the final
  // check has already moved the message to `drafted`, and the intent is not
  // written for a message this path no longer holds.
  it("does not schedule a message that has left the approved state", async () => {
    const seeded = await seed({ status: "drafted" });

    expect(
      await scheduleSendIntent(db, {
        messageId: seeded.message.id,
        now: FRIDAY_EVENING,
      }),
    ).toEqual({ ok: false, code: "NOT_SCHEDULABLE" });
  });

  it("cancels an intent, and admits when there is nothing left to cancel", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    expect(await cancelSendIntent(db, seeded.message.id)).toBe(true);
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: null,
      sendIntentExpiresAt: null,
    });
    // A second cancel has nothing to do, and says so rather than reporting a
    // cancellation that did not happen.
    expect(await cancelSendIntent(db, seeded.message.id)).toBe(false);
  });

  // Everything above injects its verdict and its send. This one does not: it
  // runs the stage the worker runs, so the real wiring — the policy read, the
  // provider lookup, the send service — is exercised rather than assumed. It
  // is the same short-circuit the first review of this iteration caught in the
  // command queue, and it would have hidden any mistake in the wiring itself.
  //
  // The calendar is opened for every day and every hour on purpose. The lane
  // reads the wall clock rather than the tick's instant, so a test that froze
  // the policy on a Monday morning would pass or fail depending on the day the
  // suite happens to run. Opening the calendar removes the calendar from what
  // this test is about, which is the wiring.
  it("delivers through the real recovery stage, and consumes the intent", async () => {
    await settings({
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 24 * 60,
    });
    const seeded = await seed();
    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });
    expect(scheduled).toMatchObject({ ok: true });
    // Due as of any wall clock this suite can run at.
    await db
      .update(schema.messages)
      .set({
        scheduledAt: FRIDAY_EVENING,
        sendIntentExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
      .where(eq(schema.messages.id, seeded.message.id));

    const services = createWorkflowTaskServices(db, {});
    const round = (await services["recover-stale-work"]({
      observedAt: MONDAY_MORNING.toISOString(),
      limit: 1,
    })) as { scheduledSends: Array<{ disposition: string }> };

    expect(round.scheduledSends).toEqual([
      { messageId: seeded.message.id, disposition: "sent" },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored.status).toBe("sent");
    expect(stored.sentAt).not.toBeNull();
    // The intent is consumed by the claim, not left behind as dead data
    // contradicting what the column means.
    expect(stored.scheduledAt).toBeNull();
    expect(stored.sendIntentExpiresAt).toBeNull();
    // And the completion window still bounds it: the dispatch stamped a fresh
    // request clock, because from the claim onwards this is a send in flight.
    expect(stored.sendRequestedAt).not.toBeNull();
  });

  // Reading the wall clock when the lane looks is only half of it. The look is
  // a cheap opinion; the authority is the policy `sendApprovedMessage`
  // re-evaluates under a row lock, and that happens after up to three provider
  // round trips — each of which may take the full 150-second transport budget
  // on a slow SMTP server. Handing the lane's instant down to the send froze
  // that authority on the moment of the look, so those minutes could not be
  // seen: a message judged legal at 17:59 left the building at 18:04, after
  // the window the operator configured had shut. Nothing in the audit said so,
  // because the row recorded the frozen instant too.
  it("re-reads the clock at the final check, so a slow provider cannot outlast the window", async () => {
    // UTC and every day, so only the hour decides — the calendar is not what
    // this test is about, and the suite must mean the same thing on a Sunday.
    await settings({
      timezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 9 * 60,
      workingEndMinute: 18 * 60,
    });
    const seeded = await seed();
    const beforeClose = new Date("2026-08-19T17:59:00.000Z");
    const afterClose = new Date("2026-08-19T18:04:00.000Z");
    await db
      .update(schema.messages)
      .set({
        scheduledAt: beforeClose,
        sendIntentExpiresAt: new Date("2026-08-20T09:00:00.000Z"),
      })
      .where(eq(schema.messages.id, seeded.message.id));

    // The slow provider, and nothing else about it: the draft round trip takes
    // five minutes of wall time, exactly as a stalling SMTP server would.
    const createDraft = DatabaseMockMailProvider.prototype.createDraft;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(beforeClose);
    DatabaseMockMailProvider.prototype.createDraft = async function (input) {
      vi.setSystemTime(afterClose);
      return createDraft.call(this, input);
    };
    let round: { scheduledSends: Array<{ disposition: string }> };
    try {
      const services = createWorkflowTaskServices(db, {});
      round = (await services["recover-stale-work"]({
        observedAt: beforeClose.toISOString(),
        limit: 1,
      })) as { scheduledSends: Array<{ disposition: string }> };
    } finally {
      DatabaseMockMailProvider.prototype.createDraft = createDraft;
      vi.useRealTimers();
    }

    // The lane's look said yes at 17:59. The authority, reading the real
    // clock, says no at 18:04 — so the message comes back to the operator
    // instead of leaving after hours.
    expect(round.scheduledSends).toEqual([
      {
        messageId: seeded.message.id,
        disposition: "abandoned",
        reason: "OUTSIDE_WORKING_HOURS",
      },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored.status).not.toBe("sent");
    expect(stored.sentAt).toBeNull();
  });

  // The same replacement, one branch over. The test above lands on the expiry
  // branch; this one lands on the ordinary push-forward, which is where most
  // rows in most passes end up and which carries its own copy of the guard. A
  // pass that pushed a replaced intent to its own next look would drag the
  // operator's new choice hours earlier without being asked.
  it("leaves a replaced intent alone on the ordinary push forward too", async () => {
    await settings({
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 24 * 60,
    });
    const first = await seed();
    const replaced = await seed();
    const now = new Date("2026-08-17T10:00:00.000Z");
    await db
      .update(schema.messages)
      .set({
        scheduledAt: new Date(now.getTime() - 60_000),
        sendIntentExpiresAt: new Date(now.getTime() + 60 * 60_000),
      })
      .where(eq(schema.messages.id, first.message.id));
    // Not expired, unlike the test above: this row is still perfectly alive, so
    // the pass reaches it with a refusal to push rather than an intent to end.
    await db
      .update(schema.messages)
      .set({
        scheduledAt: new Date(now.getTime() - 30_000),
        sendIntentExpiresAt: new Date(now.getTime() + 60 * 60_000),
      })
      .where(eq(schema.messages.id, replaced.message.id));

    const rescheduledFor = new Date(now.getTime() + 6 * 60 * 60_000);
    const outcomes = await dispatchScheduledSends(
      db,
      async (messageId) => {
        if (messageId === first.message.id) {
          expect(await cancelSendIntent(db, replaced.message.id)).toBe(true);
          const again = await scheduleSendIntent(db, {
            messageId: replaced.message.id,
            now,
            notBefore: rescheduledFor,
          });
          if (!again.ok) throw new Error(again.code);
        }
        return { ok: false, code: "MAILBOX_DAILY_CAP_REACHED" };
      },
      async () => {
        throw new Error("no send is expected in this pass");
      },
      { now },
    );

    expect(
      outcomes.find((outcome) => outcome.messageId === replaced.message.id),
    ).toEqual({ messageId: replaced.message.id, disposition: "withdrawn" });
    // The operator's instant, not this pass's five minutes.
    expect((await read(replaced.message.id)).scheduledAt).toEqual(
      rescheduledFor,
    );
  });

  // The list of due intents is read once and then walked, with a policy read
  // between items and, for one of them, a whole send that can hold the pass
  // open for the provider's full transport budget. That is plenty of time for
  // the operator to cancel a standing intent on `/review` and schedule it
  // again — two ordinary clicks. Reaching that row afterwards and clearing it
  // on the strength of the expiry this pass read threw the new intent away and
  // wrote "expired" over a decision made seconds earlier.
  it("leaves alone an intent the operator replaced while the pass was running", async () => {
    await settings({
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workingStartMinute: 0,
      workingEndMinute: 24 * 60,
    });
    const first = await seed();
    const replaced = await seed();
    const now = new Date("2026-08-17T10:00:00.000Z");
    // `first` sorts ahead, so it is the row being worked on when the operator
    // acts; `replaced` carries an expiry this pass would otherwise act on.
    await db
      .update(schema.messages)
      .set({
        scheduledAt: new Date(now.getTime() - 60_000),
        sendIntentExpiresAt: new Date(now.getTime() + 60 * 60_000),
      })
      .where(eq(schema.messages.id, first.message.id));
    await db
      .update(schema.messages)
      .set({
        scheduledAt: new Date(now.getTime() - 30_000),
        sendIntentExpiresAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(schema.messages.id, replaced.message.id));

    const rescheduledFor = new Date(now.getTime() + 6 * 60 * 60_000);
    const outcomes = await dispatchScheduledSends(
      db,
      async (messageId) => {
        if (messageId === first.message.id) {
          // The operator, on /review, while this pass is still working.
          expect(await cancelSendIntent(db, replaced.message.id)).toBe(true);
          const again = await scheduleSendIntent(db, {
            messageId: replaced.message.id,
            now,
            notBefore: rescheduledFor,
          });
          if (!again.ok) throw new Error(again.code);
        }
        return { ok: false, code: "MAILBOX_MINIMUM_DELAY" };
      },
      async () => {
        throw new Error("no send is expected in this pass");
      },
      { now },
    );

    expect(
      outcomes.find((outcome) => outcome.messageId === replaced.message.id),
    ).toEqual({ messageId: replaced.message.id, disposition: "withdrawn" });
    const stored = await read(replaced.message.id);
    expect(stored.scheduledAt).toEqual(rescheduledFor);
    expect(stored.sendIntentExpiresAt!.getTime()).toBeGreaterThan(
      now.getTime(),
    );
    expect(stored.lastError).toBeNull();
  });

  // The stage runs third, after two stages that may take minutes, so the
  // tick's `observedAt` is stale by the time it is reached. The rest of the
  // stage completes work already asked for and a late clock only makes it
  // late; this lane originates a delivery, and a delivery judged against a
  // window that has since shut is the failure the whole area exists to
  // prevent. Written against the clock rather than the calendar so it means
  // the same thing on every day of the week: an intent that is due by the
  // tick's instant and not yet due by the wall clock must not be touched.
  it("reads the wall clock, not the instant the tick started", async () => {
    const seeded = await seed();
    const wallClock = new Date();
    const halfAnHourOff = new Date(wallClock.getTime() + 30 * 60_000);
    const anHourOff = new Date(wallClock.getTime() + 60 * 60_000);
    await db
      .update(schema.messages)
      .set({
        scheduledAt: halfAnHourOff,
        sendIntentExpiresAt: new Date(wallClock.getTime() + 24 * 60 * 60_000),
      })
      .where(eq(schema.messages.id, seeded.message.id));

    const services = createWorkflowTaskServices(db, {});
    const round = (await services["recover-stale-work"]({
      observedAt: anHourOff.toISOString(),
      limit: 1,
    })) as { scheduledSends: unknown[] };

    expect(round.scheduledSends).toEqual([]);
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: halfAnHourOff,
    });
  });

  // The send notice tells the operator the review card offers a schedule. For
  // a daily cap the wait has no nameable instant, and the offer used to be
  // skipped for exactly that reason — pointing at a button nobody rendered.
  it("still schedules a refusal whose length is unknown", async () => {
    const seeded = await seed();

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: MONDAY_MORNING,
    });

    expect(scheduled).toMatchObject({ ok: true });
    const stored = await read(seeded.message.id);
    expect(stored.scheduledAt).not.toBeNull();
    // A rolling 24-hour cap clears inside the intent's life, so waiting it out
    // is a real answer rather than a promise that expires.
    expect(stored.sendIntentExpiresAt!.getTime()).toBe(
      MONDAY_MORNING.getTime() + 24 * 60 * 60_000,
    );
  });

  it("tells a second schedule apart from a message that has moved on", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    // Already scheduled is not "no longer waiting to be sent".
    expect(
      await scheduleSendIntent(db, {
        messageId: seeded.message.id,
        now: FRIDAY_EVENING,
      }),
    ).toEqual({ ok: false, code: "ALREADY_SCHEDULED" });

    const gone = await seed({ status: "sent" });
    expect(
      await scheduleSendIntent(db, {
        messageId: gone.message.id,
        now: FRIDAY_EVENING,
      }),
    ).toEqual({ ok: false, code: "NOT_SCHEDULABLE" });
  });

  // The click that must never become tomorrow's send.
  //
  // A refusal on the sixty-second pacing delay is taken on without asking
  // because a minute is not a decision. Nothing re-asks afterwards, so if the
  // refusal changes underneath — the cap fills, the window shuts — the intent
  // would keep following it into the next morning and deliver unattended,
  // which is the 2026-08-14 incident with a schedule in front of it. An intent
  // nobody was asked about gives up inside the hour it was promised.
  it("gives an automatically taken intent up rather than carrying it overnight", async () => {
    const seeded = await seed();
    // Monday 14:00 Paris, well inside the window.
    const click = new Date("2026-08-17T12:00:00.000Z");

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: click,
      lifetimeMs: AUTOMATIC_INTENT_LIFETIME_MS,
    });

    expect(scheduled).toMatchObject({ ok: true });
    expect((await read(seeded.message.id)).sendIntentExpiresAt!.getTime()).toBe(
      click.getTime() + 60 * 60_000,
    );
    // Tuesday 09:00, with a policy that would now say yes.
    const sent: string[] = [];
    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async (id) => {
        sent.push(id);
        return { ok: true };
      },
      { now: new Date("2026-08-18T07:00:00.000Z") },
    );

    expect(sent).toEqual([]);
    expect(outcomes).toEqual([
      { messageId: seeded.message.id, disposition: "expired" },
    ]);
    // And it is back with the operator rather than silently gone.
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: null,
    });
  });

  // The other side of the same rule: a wait the operator chose is a wait they
  // chose, and it keeps its day.
  it("keeps a day for an intent the operator asked for", async () => {
    const seeded = await seed();

    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    expect((await read(seeded.message.id)).sendIntentExpiresAt!.getTime()).toBe(
      MONDAY_MORNING.getTime() + 24 * 60 * 60_000,
    );
  });

  // The send button announces an instant before it stores one. Storing a
  // different instant than the one just shown is how "going out on its own at
  // 14:00" comes to mean 14:05, and how `/outbound` shows a "goes out" column
  // that disagrees with the notice the operator read a second earlier.
  it("stores the instant the caller was shown", async () => {
    const seeded = await seed();
    const click = new Date("2026-08-17T12:00:00.000Z");
    const shown = new Date(click.getTime() + 60_000);

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: click,
      notBefore: shown,
    });

    expect(scheduled).toMatchObject({ ok: true, scheduledAt: shown });
    expect((await read(seeded.message.id)).scheduledAt).toEqual(shown);
  });

  // A send refused at 18:00 because the window shut has nothing to learn from
  // being asked again at 18:05, and the stored instant is what `/outbound`
  // shows as "goes out". The flat cadence stays for refusals with no nameable
  // end, which is what a rolling daily cap is.
  it("looks again when the refusal says to, not five minutes later", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });
    // Monday 18:05 Paris — the window has just shut.
    const shutMonday = new Date("2026-08-17T16:05:00.000Z");
    await db
      .update(schema.messages)
      .set({
        scheduledAt: shutMonday,
        // The intent has to be able to live to the instant it is pushed to.
        // The one written on Friday expires Tuesday 09:00 to the second, which
        // is the same instant this refusal names — the case the next test is
        // about. Given room here, so this test is about the push alone.
        sendIntentExpiresAt: new Date("2026-08-18T16:00:00.000Z"),
      })
      .where(eq(schema.messages.id, seeded.message.id));

    await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code: "OUTSIDE_WORKING_HOURS" }),
      async () => {
        throw new Error("a refused send must not be attempted");
      },
      { now: shutMonday },
    );

    // Tuesday 09:00 Paris, not 18:10.
    expect((await read(seeded.message.id)).scheduledAt).toEqual(
      new Date("2026-08-18T07:00:00.000Z"),
    );
  });

  // The other half of pushing the next look to the instant the refusal names:
  // that instant can land past the intent's own expiry, and then it is not a
  // next look at all. Left alone, `/outbound` shows a "goes out" later than its
  // own "expires", the message stays out of the review queue all night, and the
  // lane answers the promise the next morning by expiring the intent instead of
  // sending it. The click is handed back now, while the operator who made it is
  // still at their desk.
  //
  // Reached by the ordinary end-of-day batch: an intent the send button took on
  // at 17:30 for the sixty-second pacing delay, still being refused at 17:59:30,
  // when a minute later is tomorrow.
  it("hands back an intent it cannot keep rather than naming an instant it will never reach", async () => {
    await settings({ mailboxMinimumDelaySeconds: 60 });
    const seeded = await seed();
    // Monday 17:30 Paris. Taken on without asking, so it lives an hour.
    const takenOn = new Date("2026-08-17T15:30:00.000Z");
    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: takenOn,
      lifetimeMs: AUTOMATIC_INTENT_LIFETIME_MS,
    });
    expect(scheduled).toMatchObject({ ok: true });
    // Monday 17:59:30 Paris: the pacing delay ends at 18:00:30, after the
    // window shuts, so the refusal now names Tuesday morning — well past the
    // 18:30 expiry this intent was written with.
    const lateMonday = new Date("2026-08-17T15:59:30.000Z");
    await db
      .update(schema.messages)
      .set({ scheduledAt: lateMonday })
      .where(eq(schema.messages.id, seeded.message.id));

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code: "MAILBOX_MINIMUM_DELAY" }),
      async () => {
        throw new Error("a refused send must not be attempted");
      },
      { now: lateMonday },
    );

    expect(outcomes).toEqual([
      {
        messageId: seeded.message.id,
        disposition: "expired",
        reason: "MAILBOX_MINIMUM_DELAY",
      },
    ]);
    const stored = await read(seeded.message.id);
    expect(stored).toMatchObject({
      status: "approved",
      scheduledAt: null,
      sendIntentExpiresAt: null,
      sentAt: null,
    });
    expect(stored.lastError).toContain("MAILBOX_MINIMUM_DELAY");
  });

  // Cancelling and sending are a race, and the operator's side of it must win
  // or lose honestly. A cancel landing between the lane's read and its send
  // used to be answered "Scheduled send cancelled" while the email went out
  // anyway — the one outcome this feature cannot afford, because an email is
  // not recallable. The cancel is staged here from inside the verdict read,
  // which is exactly the gap the race lived in.
  it("does not send an intent the operator cancelled while the lane was looking", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });
    const sent: string[] = [];

    const outcomes = await dispatchScheduledSends(
      db,
      async (id) => {
        expect(await cancelSendIntent(db, id)).toBe(true);
        return { ok: true };
      },
      async (id) => {
        sent.push(id);
        return { ok: true };
      },
      { now: MONDAY_MORNING },
    );

    expect(sent).toEqual([]);
    expect(outcomes).toEqual([
      { messageId: seeded.message.id, disposition: "withdrawn" },
    ]);
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: null,
      sentAt: null,
    });
  });

  // The delays the settings name are upper bounds, not appointments. A contact
  // delay of 1440 minutes — the shipped default, and what the live install
  // carries — says "at most a day", while the real wait is whatever remains of
  // it measured from the last actual contact, which is normally far shorter.
  // Waking at the bound skips every instant the delay actually clears in, and
  // the bound is a day away, so the intent expires before its own next look
  // ever arrives: the operator clicks Schedule, and a minute later the message
  // is back in the queue saying the policy never allowed it. The calendar is
  // the only thing the lane may skip ahead on, because a shut window is a fact
  // rather than a ceiling.
  it("keeps looking on the cadence for a delay whose end is only an upper bound", async () => {
    await settings({ contactMinimumDelayMinutes: 24 * 60 });
    const seeded = await seed();
    // Monday 14:00 Paris, well inside the window, as the card's offer requires.
    const click = new Date("2026-08-17T12:00:00.000Z");
    await scheduleSendIntent(db, { messageId: seeded.message.id, now: click });

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code: "CONTACT_MINIMUM_DELAY" }),
      async () => {
        throw new Error("a refused send must not be attempted");
      },
      { now: click },
    );

    expect(outcomes).toEqual([
      {
        messageId: seeded.message.id,
        disposition: "waiting",
        reason: "CONTACT_MINIMUM_DELAY",
      },
    ]);
    expect((await read(seeded.message.id)).scheduledAt).toEqual(
      new Date(click.getTime() + 5 * 60_000),
    );
  });

  // The regression this whole lifetime rule exists for, driven end to end.
  //
  // The card offers "Schedule for <the instant the contact delay clears>" and
  // the click writes an intent. Counted from the click, that intent's day ends
  // on the very instant the button promised — so the lane spent 24 hours
  // rechecking and then expired the click five minutes before the only look
  // that could have sent it. Nothing was delivered, and nothing looked wrong
  // until the day was over.
  it("survives to the instant the card promised, and sends there", async () => {
    await settings({ contactMinimumDelayMinutes: 24 * 60 });
    const seeded = await seed();
    // Monday 14:00 Paris, well inside the window, as the card's offer requires.
    const click = new Date("2026-08-17T12:00:00.000Z");
    const promised = nextLegalSendInstant("CONTACT_MINIMUM_DELAY", click, {
      timezone: "Europe/Paris",
      workingDays: [1, 2, 3, 4, 5],
      workingStartMinute: 9 * 60,
      workingEndMinute: 18 * 60,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 24 * 60,
    })!;

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: click,
      lifetimeMs: operatorIntentLifetimeMs("CONTACT_MINIMUM_DELAY", click, {
        timezone: "Europe/Paris",
        workingDays: [1, 2, 3, 4, 5],
        workingStartMinute: 9 * 60,
        workingEndMinute: 18 * 60,
        mailboxMinimumDelaySeconds: 0,
        contactMinimumDelayMinutes: 24 * 60,
      }),
    });
    if (!scheduled.ok) throw new Error(scheduled.code);
    // The intent can now outlive the instant it was created for.
    expect(scheduled.expiresAt.getTime()).toBeGreaterThan(promised.getTime());

    // Walk the lane forward on its five-minute cadence, refusing until the
    // delay genuinely clears, exactly as the policy would.
    const sent: string[] = [];
    let dispositions: string[] = [];
    for (
      let at = click.getTime();
      at <= promised.getTime() + 60_000;
      at += 5 * 60_000
    ) {
      const outcomes = await dispatchScheduledSends(
        db,
        async () =>
          at < promised.getTime()
            ? { ok: false, code: "CONTACT_MINIMUM_DELAY" }
            : { ok: true },
        async (messageId) => {
          sent.push(messageId);
          return { ok: true };
        },
        { now: new Date(at) },
      );
      dispositions = dispositions.concat(
        outcomes.map((outcome) => outcome.disposition),
      );
      if (sent.length > 0) break;
    }

    expect(sent).toEqual([seeded.message.id]);
    expect(dispositions).not.toContain("expired");
  });

  // The same click, made on the day of the week that used to kill it.
  //
  // Friday afternoon, inside the window, with the shipped 24-hour contact
  // delay: the card offers Monday 09:00 because the delay clears on Saturday
  // and Saturday is not a working day. The intent's day of trying was counted
  // from the click, so it was spent on a weekend during which nothing could
  // have gone out — and at 18:05 that same Friday, when the lane pushed its
  // next look to Monday, that look was already past the expiry and the click
  // was handed back. Four hours after it was made, for a send three days out.
  it("survives the weekend a Friday-afternoon click has to cross", async () => {
    await settings({ contactMinimumDelayMinutes: 24 * 60 });
    const seeded = await seed();
    const paris = {
      timezone: "Europe/Paris",
      workingDays: [1, 2, 3, 4, 5],
      workingStartMinute: 9 * 60,
      workingEndMinute: 18 * 60,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 24 * 60,
    };
    // Friday 2026-08-14, 14:00 Paris.
    const click = new Date("2026-08-14T12:00:00.000Z");
    const promised = nextLegalSendInstant(
      "CONTACT_MINIMUM_DELAY",
      click,
      paris,
    )!;
    expect(promised).toEqual(MONDAY_MORNING);

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: click,
      lifetimeMs: operatorIntentLifetimeMs(
        "CONTACT_MINIMUM_DELAY",
        click,
        paris,
      ),
    });
    if (!scheduled.ok) throw new Error(scheduled.code);
    expect(scheduled.expiresAt.getTime()).toBeGreaterThan(promised.getTime());

    // The three looks that decide it: one while the delay still holds, one at
    // the moment the window shuts — where the lane jumps to Monday and the old
    // rule expired the click — and Monday's, where it goes.
    const dispositions: string[] = [];
    const sent: string[] = [];
    for (const [at, allowed] of [
      [new Date("2026-08-14T12:05:00.000Z"), false],
      [new Date("2026-08-14T16:05:00.000Z"), false],
      [MONDAY_MORNING, true],
    ] as const) {
      const outcomes = await dispatchScheduledSends(
        db,
        async () =>
          allowed
            ? { ok: true }
            : {
                ok: false,
                code:
                  at.getTime() < new Date("2026-08-14T16:00:00.000Z").getTime()
                    ? "CONTACT_MINIMUM_DELAY"
                    : "OUTSIDE_WORKING_HOURS",
              },
        async (messageId) => {
          sent.push(messageId);
          return { ok: true };
        },
        { now: at },
      );
      dispositions.push(...outcomes.map((outcome) => outcome.disposition));
      // The look at 18:05 must park the intent on Monday morning, not end it.
      if (at.getTime() === new Date("2026-08-14T16:05:00.000Z").getTime()) {
        expect(await read(seeded.message.id)).toMatchObject({
          status: "approved",
          scheduledAt: MONDAY_MORNING,
        });
      }
    }

    expect(dispositions).toEqual(["waiting", "waiting", "sent"]);
    expect(sent).toEqual([seeded.message.id]);
  });

  // A rolling cap names no instant, so the card does not name one either — but
  // the cap still clears inside its own day, and on a Friday afternoon that day
  // is the weekend. The intent has to be able to keep asking across it.
  it("keeps a Friday click on a capped mailbox alive until Monday", async () => {
    const seeded = await seed();
    const paris = {
      timezone: "Europe/Paris",
      workingDays: [1, 2, 3, 4, 5],
      workingStartMinute: 9 * 60,
      workingEndMinute: 18 * 60,
      mailboxMinimumDelaySeconds: 0,
      contactMinimumDelayMinutes: 0,
    };
    const click = new Date("2026-08-14T12:00:00.000Z");

    const scheduled = await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: click,
      lifetimeMs: operatorIntentLifetimeMs(
        "MAILBOX_DAILY_CAP_REACHED",
        click,
        paris,
      ),
    });
    if (!scheduled.ok) throw new Error(scheduled.code);

    // The look that shuts the window jumps to Monday; the intent must outlive
    // it rather than be handed back on the spot.
    const shutting = await dispatchScheduledSends(
      db,
      async () => ({ ok: false, code: "OUTSIDE_WORKING_HOURS" }),
      async () => {
        throw new Error("nothing may be sent while the window is shut");
      },
      { now: new Date("2026-08-14T16:05:00.000Z") },
    );

    expect(shutting.map((outcome) => outcome.disposition)).toEqual(["waiting"]);
    expect(await read(seeded.message.id)).toMatchObject({
      scheduledAt: MONDAY_MORNING,
    });
  });

  // One intent buys one attempt. The lane takes the intent before it sends, so
  // a send that fails afterwards — the claim re-reading the policy under its
  // row lock and refusing, a provider that will not take it — leaves the
  // message `approved` with nothing scheduled, which is to say back in the
  // review queue carrying the reason. The alternative, leaving the intent
  // standing, is a click that retries by itself every five minutes for a day.
  it("gives the message back to the operator when the send fails after the intent was taken", async () => {
    const seeded = await seed();
    await scheduleSendIntent(db, {
      messageId: seeded.message.id,
      now: FRIDAY_EVENING,
    });

    const outcomes = await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async () => ({ ok: false, code: "MAILBOX_DAILY_CAP_REACHED" }),
      { now: MONDAY_MORNING },
    );

    expect(outcomes).toEqual([
      {
        messageId: seeded.message.id,
        disposition: "abandoned",
        reason: "MAILBOX_DAILY_CAP_REACHED",
      },
    ]);
    expect(await read(seeded.message.id)).toMatchObject({
      status: "approved",
      scheduledAt: null,
      sendIntentExpiresAt: null,
      sentAt: null,
    });
    // And it is genuinely back in front of the operator, not merely untouched:
    // the page that lists what is waiting for a slot no longer carries it.
    expect(
      (await readScheduledSends(db)).map((row) => row.messageId),
    ).not.toContain(seeded.message.id);
  });

  it("drains the oldest intent first and sends at most one a pass", async () => {
    const first = await seed();
    const second = await seed();
    await scheduleSendIntent(db, {
      messageId: first.message.id,
      now: FRIDAY_EVENING,
    });
    await scheduleSendIntent(db, {
      messageId: second.message.id,
      now: new Date(FRIDAY_EVENING.getTime() + 60_000),
    });
    // Both open on Monday, so order them by hand to make "oldest first" mean
    // something the test can see.
    await db
      .update(schema.messages)
      .set({ scheduledAt: new Date(MONDAY_MORNING.getTime() - 60_000) })
      .where(eq(schema.messages.id, first.message.id));
    const sentIds: string[] = [];

    await dispatchScheduledSends(
      db,
      async () => ({ ok: true }),
      async (id) => {
        sentIds.push(id);
        return { ok: true };
      },
      { now: MONDAY_MORNING },
    );

    expect(sentIds).toEqual([first.message.id]);
  });
});
