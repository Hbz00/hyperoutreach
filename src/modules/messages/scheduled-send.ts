import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";

import { messages, operatorSendingSettings } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { isTransientSendBlock } from "@/modules/messages/send-policy";
import {
  nextWorkingInstant,
  operatorClock,
} from "@/modules/settings/working-hours";

/** How often the lane re-asks the policy while an intent is waiting. */
const RECHECK_MS = 5 * 60_000;

/**
 * How a standing intent should name the instant it carries.
 *
 * That instant is two different things depending on the refusal. When the
 * calendar is what stands in the way, it is a real delivery time — Monday
 * 09:00 — and naming it answers the operator's actual question. When the
 * refusal is a delay, the lane cannot know when it truly lifts (the settings
 * only carry a ceiling), so it stores its own next look: five minutes out,
 * again and again, until the delay clears and the message goes.
 *
 * Printed literally, that second case says "goes out in 5 minutes" for as long
 * as a day, on a page whose whole subject is what is leaving the building. It
 * does not read as vague, it reads as an imminent send nobody asked for — and
 * on this product, of all products, that is a sentence that gets something
 * cancelled in a panic. The instant is only printed when it is a delivery
 * time; otherwise this says the same thing the send notice already says, so
 * one click tells one story on all three surfaces.
 *
 * Composed to follow "Scheduled for", and to stand alone in a table cell.
 */
export function scheduledInstantLabel(
  scheduledAt: Date,
  now: Date,
  timezone?: string,
): string {
  return scheduledAt.getTime() > now.getTime() + RECHECK_MS
    ? operatorClock(scheduledAt, timezone)
    : "the first instant the policy allows";
}

/**
 * How long an intent survives once the calendar has actually opened.
 *
 * Measured from the first legal instant rather than from the click, because
 * those are days apart across a weekend. A Friday-evening click that opens on
 * Monday morning gets its day of trying on Monday, not a lifetime that ran out
 * on Saturday while nothing could have been sent anyway.
 */
const LIFETIME_AFTER_OPENING_MS = 24 * 60 * 60_000;

/**
 * When a transient refusal might stop being one, or `null` when that is not
 * knowable from the settings alone.
 *
 * This is the distance the operator is asked to accept, and it is not the same
 * question as "when does the calendar next open". Inside working hours a
 * refusal on the per-mailbox delay clears in a minute while a refusal on the
 * daily cap clears in up to a day — both would answer "now" if the calendar
 * were the only thing consulted, and the second would silently commit the
 * operator to a wait they never saw.
 *
 * The delays are upper bounds read from the settings: the real wait is
 * whatever remains of them, which is shorter. Caps answer `null` on purpose —
 * a rolling 24-hour window has no instant the settings can name, and pretending
 * otherwise would be the same lie in the other direction.
 */
export function nextAttemptInstantFor(
  code: string,
  now: Date,
  settings: {
    timezone: string;
    workingDays: number[];
    workingStartMinute: number;
    workingEndMinute: number;
    mailboxMinimumDelaySeconds: number;
    contactMinimumDelayMinutes: number;
  },
): Date | null {
  if (code === "OUTSIDE_WORKING_HOURS") {
    return nextWorkingInstant(now, settings);
  }
  if (code === "MAILBOX_MINIMUM_DELAY") {
    return new Date(
      now.getTime() + settings.mailboxMinimumDelaySeconds * 1_000,
    );
  }
  if (code === "CONTACT_MINIMUM_DELAY") {
    return new Date(
      now.getTime() + settings.contactMinimumDelayMinutes * 60_000,
    );
  }
  return null;
}

/**
 * The first instant this refusal could actually become a send, or `null` when
 * that is not knowable from the settings alone.
 *
 * `nextAttemptInstantFor` answers when the *named* obstacle clears, which is
 * not the same question: at 17:59 the sixty-second pacing delay clears at
 * 18:00:30, and nothing may leave at 18:00:30 because the window has shut by
 * then. Answering "a minute" there is how a click the operator was told would
 * go out immediately becomes tomorrow morning's unattended send. So the
 * calendar is applied on top of the delay, and this — not the bare delay — is
 * what both the "take it on without asking" decision and the card's label are
 * read from.
 *
 * Still a bound rather than an appointment, and only ever used to *decide*.
 * The calendar half is exact; the delay half is the ceiling the settings
 * carry, and the real wait — measured from the last actual activity — is
 * shorter. That is safe for the two questions asked here, which both fail
 * towards the operator: an over-estimate declines to take a wait on, and
 * offers a button naming an instant the send may beat. It is not safe for
 * "when should the lane look again", which is why that reads the calendar
 * directly instead.
 */
export function nextLegalSendInstant(
  code: string,
  now: Date,
  settings: {
    timezone: string;
    workingDays: number[];
    workingStartMinute: number;
    workingEndMinute: number;
    mailboxMinimumDelaySeconds: number;
    contactMinimumDelayMinutes: number;
  },
): Date | null {
  const earliest = nextAttemptInstantFor(code, now, settings);
  if (!earliest) return null;
  return nextWorkingInstant(earliest, settings);
}

/**
 * How close a wait has to be for the system to take it on without asking.
 *
 * An hour is the line between "you would not want to think about this" — the
 * sixty-second pacing delay that refuses clicks two through five of a batch —
 * and "this is a decision": a click on Friday evening that would leave on
 * Monday morning, out of the context that prompted it.
 */
export const AUTO_SCHEDULE_WITHIN_MS = 60 * 60_000;

/**
 * How long an intent nobody was asked about survives.
 *
 * An intent the operator chose gets a day, because they chose the wait. An
 * intent the send button took on for them was justified by one sentence —
 * "this clears within the hour" — and that sentence stops being true the
 * moment the refusal changes underneath it: a pacing delay clears, the daily
 * cap fills, the window shuts, and the same intent is now waiting for
 * tomorrow morning. Nothing re-asks the operator, so the intent has to give
 * up on its own and hand the message back.
 *
 * An hour of *trying*, counted like every other lifetime here from the instant
 * the wait was for rather than from the click — and that instant is itself up
 * to an hour out, so the outside bound on an unattended send is two hours
 * after the button was pressed, not one. Measuring from the click instead
 * would leave an intent taken on at 08:05 for a 09:00 opening with five
 * minutes of trying, which is not the shorter promise it sounds like: it is
 * the same click failing for a reason the operator never sees. Two hours is
 * still inside the working day the click was made in, which is the property
 * that matters.
 */
export const AUTOMATIC_INTENT_LIFETIME_MS = AUTO_SCHEDULE_WITHIN_MS;

/**
 * Whether this refusal is close enough to wait out without asking.
 *
 * Deliberately a plain boolean and not a type guard on `instant`: `false` here
 * means "not soon", which includes a perfectly good instant that happens to be
 * three days away. Narrowing on it would tell the compiler the opposite.
 */
export function shouldAutoSchedule(instant: Date | null, now: Date): boolean {
  if (!instant) return false;
  return instant.getTime() - now.getTime() <= AUTO_SCHEDULE_WITHIN_MS;
}

/**
 * What the send button should do with the refusal it just received: take the
 * wait on, or leave the decision to the operator.
 *
 * Three answers have to agree — which instant, whether it is close enough, and
 * how long the resulting intent may live — and they were three separate
 * expressions sitting in the route with nothing checking that they matched.
 * They are not independent: the hour of lifetime is granted *because* the
 * instant was within the hour, and an instant read from the bare delay while
 * the lifetime is read from the calendar is exactly the mismatch that turns a
 * one-minute wait into tomorrow morning. Returning them together makes the
 * rule one testable thing rather than a coincidence, the same reason
 * `scheduleOfferLabel` was lifted out of the JSX.
 *
 * `null` means "do not take it on": the refusal is permanent, its end is not
 * nameable, or the wait is far enough away to be the operator's call — the
 * card offers it there instead.
 */
export function autoScheduleIntent(
  code: string,
  now: Date,
  settings: {
    timezone: string;
    workingDays: number[];
    workingStartMinute: number;
    workingEndMinute: number;
    mailboxMinimumDelaySeconds: number;
    contactMinimumDelayMinutes: number;
  },
): { notBefore: Date; lifetimeMs: number } | null {
  if (!isTransientSendBlock(code)) return null;
  const instant = nextLegalSendInstant(code, now, settings);
  if (!instant || !shouldAutoSchedule(instant, now)) return null;
  return { notBefore: instant, lifetimeMs: AUTOMATIC_INTENT_LIFETIME_MS };
}

/**
 * The label of the "schedule this" control, or `null` when there is nothing to
 * offer.
 *
 * Extracted from the review page so the decision is testable: which refusals
 * earn an offer, and what the button says, are product rules, and leaving them
 * inline in JSX put them beyond the reach of everything but a browser run.
 *
 * `null` covers four different situations that all mean "no button": the send
 * would go out now, the refusal is permanent, the wait is short enough that
 * the send button already took it on without asking, or the message is no
 * longer in a state an intent can be written for.
 *
 * That last one is not a detail. The verdict is rendered for `drafted` cards
 * too — the policy accepts that status — and `drafted` is exactly where a send
 * refused at the final check lands, which is the 17:59/18:00 case this whole
 * lane was built around. Offering there rendered a button whose route answered
 * "no longer waiting to be sent". The card only offers what the route can
 * honour.
 */
export function scheduleOfferLabel(
  verdict: { ok: boolean; code?: string },
  now: Date,
  settings: {
    timezone: string;
    workingDays: number[];
    workingStartMinute: number;
    workingEndMinute: number;
    mailboxMinimumDelaySeconds: number;
    contactMinimumDelayMinutes: number;
  },
  options: { alreadyScheduled?: boolean; schedulable?: boolean } = {},
): string | null {
  if (options.schedulable === false) return null;
  if (options.alreadyScheduled) return null;
  if (verdict.ok || !verdict.code) return null;
  if (!isTransientSendBlock(verdict.code)) return null;
  const instant = nextLegalSendInstant(verdict.code, now, settings);
  if (shouldAutoSchedule(instant, now)) return null;
  return instant
    ? `Schedule for ${operatorClock(instant, settings.timezone)}`
    : // A rolling daily cap has no instant the settings can name. Saying so is
      // better than naming one that would be wrong.
      "Schedule — it goes out when the cap clears";
}

export type ScheduleSendIntentResult =
  | { ok: true; scheduledAt: Date; expiresAt: Date; timezone: string }
  | {
      ok: false;
      code: "NO_WORKING_SLOT" | "ALREADY_SCHEDULED" | "NOT_SCHEDULABLE";
    };

/**
 * Records that the operator asked for this message to go out at the next legal
 * instant.
 *
 * Written here and never inside `sendApprovedMessage`, deliberately. The send
 * function is also called by the automatic follow-up path and by stale-work
 * recovery; writing the intent there would let the system schedule its own
 * sends, which is the failure this whole area exists to prevent. The intent is
 * a record of a human gesture, so it is written where the gesture arrives.
 *
 * The update is guarded on `approved` with no intent already set. A send
 * refused at the final check has already moved the message to `drafted`, and
 * that race gives up scheduling on purpose: the operator clicks again rather
 * than the system inventing an intent for a message it no longer holds.
 */
export async function scheduleSendIntent(
  db: AppDatabase,
  input: {
    messageId: string;
    now: Date;
    /**
     * The earliest instant the caller already knows the refusal allows, when
     * it knows one. The send button does — it read the block code — and
     * passing it keeps the instant stored here identical to the instant the
     * operator was just shown. The review card does not — its button carries
     * only a message id, and re-deriving the code would cost two queries on
     * the click. It settles itself instead: the first look happens as soon as
     * the calendar opens, that look is refused, and the lane pushes it to the
     * instant the refusal names.
     *
     * The cost is that between the click and that first pass, `/outbound` can
     * name an instant earlier than the button did. Only for a pacing delay
     * configured longer than an hour — for a shut window, the two agree, since
     * "when the calendar opens" is the whole answer — and only for one tick.
     */
    notBefore?: Date;
    /** Overrides the lifetime. See `AUTOMATIC_INTENT_LIFETIME_MS`. */
    lifetimeMs?: number;
  },
): Promise<ScheduleSendIntentResult> {
  const [settings] = await db
    .select()
    .from(operatorSendingSettings)
    .where(eq(operatorSendingSettings.id, 1))
    .limit(1);
  if (!settings) return { ok: false, code: "NOT_SCHEDULABLE" };

  const earliest =
    input.notBefore && input.notBefore.getTime() > input.now.getTime()
      ? input.notBefore
      : input.now;
  const opensAt = nextWorkingInstant(earliest, settings);
  // No working day is configured at all, so there is no instant to wait for.
  // Saying so beats writing an intent that can only ever expire.
  if (!opensAt) return { ok: false, code: "NO_WORKING_SLOT" };

  const expiresAt = new Date(
    opensAt.getTime() + (input.lifetimeMs ?? LIFETIME_AFTER_OPENING_MS),
  );
  const [updated] = await db
    .update(messages)
    .set({ scheduledAt: opensAt, sendIntentExpiresAt: expiresAt })
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.status, "approved"),
        sql`${messages.scheduledAt} is null`,
      ),
    )
    .returning({ id: messages.id });
  if (!updated) {
    // Which of the two guards failed. "No longer waiting to be sent" is false
    // for a message that is simply scheduled already, and the operator who
    // double-clicked deserves the difference — the cancel path distinguishes
    // its cases, so this one should too.
    const [current] = await db
      .select({ status: messages.status, scheduledAt: messages.scheduledAt })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .limit(1);
    return {
      ok: false,
      code:
        current?.status === "approved" && current.scheduledAt
          ? "ALREADY_SCHEDULED"
          : "NOT_SCHEDULABLE",
    };
  }
  // The timezone travels with the instant: the caller renders it, and a slot
  // computed against a 09:00 calendar must not be announced as 07:00 UTC.
  return {
    ok: true,
    scheduledAt: opensAt,
    expiresAt,
    timezone: settings.timezone,
  };
}

/**
 * Drops an intent at the operator's request.
 *
 * Guarded on `approved`: once the lane has claimed the message the send is
 * already under way and there is nothing left to cancel. The caller is told
 * which happened rather than being allowed to report a cancellation that did
 * not occur.
 */
export async function cancelSendIntent(
  db: AppDatabase,
  messageId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(messages)
    // `lastError` is left alone. It may hold a provider failure that has
    // nothing to do with the intent, and cancelling a schedule is not a claim
    // that everything before it went well.
    .set({ scheduledAt: null, sendIntentExpiresAt: null })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.status, "approved"),
        isNotNull(messages.scheduledAt),
      ),
    )
    .returning({ id: messages.id });
  return Boolean(updated);
}

export type ScheduledSendOutcome = {
  messageId: string;
  disposition: "sent" | "waiting" | "expired" | "abandoned" | "withdrawn";
  reason?: string;
};

export type ScheduledSendExecutor = (
  messageId: string,
  at: Date,
) => Promise<{
  ok: boolean;
  code?: string;
}>;

export type ScheduledSendVerdict = (
  messageId: string,
  at: Date,
) => Promise<{ ok: boolean; code?: string } | null>;

/**
 * Executes the intents whose instant has come.
 *
 * Three properties hold this together, and each is load-bearing:
 *
 * 1. **Its own query.** Stale-work recovery still cannot select an `approved`
 *    message — that structural guarantee is untouched. This lane selects
 *    `approved` too, but only with a non-null `scheduled_at`, a column written
 *    by exactly one path: the operator's click.
 * 2. **A read before a write.** The verdict is re-read without claiming or
 *    recording anything. A refusal therefore costs one read and one timestamp
 *    push — no audit row, no claim, no attempt. Without this a message
 *    scheduled at 18:00 would write an audit row a minute all night.
 * 3. **The policy decides, again, at the end.** This lane only asks whether it
 *    is worth trying; `sendApprovedMessage` re-evaluates under a row lock and
 *    is the authority. A verdict that has gone stale between the two costs a
 *    refusal, not a wrong send.
 *
 * `now` defaults to the wall clock and production leaves it that way. This
 * lane rides in the third stage of the maintenance cycle, whose `observedAt`
 * is the instant the tick started — stale by however long inbound and
 * followups took, up to eight minutes by the shipped configuration. Selecting
 * against a stale clock only makes the lane late, which is harmless; judging
 * a *send* against one is how an email leaves after the window it was
 * measured against has shut. The instant used here is the instant handed to
 * the verdict and to the send, so all three agree.
 */
export async function dispatchScheduledSends(
  db: AppDatabase,
  verdictFor: ScheduledSendVerdict,
  send: ScheduledSendExecutor,
  options: { now?: Date; limit?: number; sendLimit?: number } = {},
): Promise<ScheduledSendOutcome[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  // At most one delivery a pass. The shipped per-mailbox delay refuses the
  // second anyway, and a burst of intents firing together is exactly what the
  // pacing settings exist to prevent.
  const sendLimit = Math.max(options.sendLimit ?? 1, 1);

  const due = await db
    .select({ id: messages.id, expiresAt: messages.sendIntentExpiresAt })
    .from(messages)
    .where(
      and(
        eq(messages.status, "approved"),
        isNotNull(messages.scheduledAt),
        lte(messages.scheduledAt, now),
      ),
    )
    // Oldest intent first: five clicks drain in the order they were made.
    .orderBy(asc(messages.scheduledAt), asc(messages.id))
    .limit(limit);

  // Read once, and only when there is work: the usual state of this lane is
  // an empty result set, and a settings read on every tick for nothing is a
  // query the operator pays for and never uses.
  const [settings] = due.length
    ? await db
        .select()
        .from(operatorSendingSettings)
        .where(eq(operatorSendingSettings.id, 1))
        .limit(1)
    : [];

  const outcomes: ScheduledSendOutcome[] = [];
  let sent = 0;
  for (const row of due) {
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
      await clearIntent(
        db,
        row.id,
        "This scheduled send expired before the policy allowed it",
      );
      outcomes.push({ messageId: row.id, disposition: "expired" });
      continue;
    }

    const verdict = await verdictFor(row.id, now);
    if (!verdict) continue;
    if (!verdict.ok) {
      const code = verdict.code ?? "UNKNOWN";
      if (!isTransientSendBlock(code)) {
        await clearIntent(
          db,
          row.id,
          `This scheduled send was cancelled: ${code}`,
        );
        outcomes.push({
          messageId: row.id,
          disposition: "abandoned",
          reason: code,
        });
        continue;
      }
      // Still refused for a reason time lifts. Push the next look forward and
      // write nothing else — no audit row for a refusal nobody attempted.
      //
      // Forward past a shut calendar, because a send refused at 18:00 for a
      // closed window has nothing to learn from being asked again at 18:05,
      // and the stored instant is what `/outbound` shows as "goes out".
      //
      // Only the calendar, though — never the instant the refusal itself
      // names. `nextAttemptInstantFor` answers with the *upper bound* the
      // settings carry for a pacing delay, while the real wait is whatever
      // remains of it measured from the last actual activity, and is normally
      // far shorter. Waking at the bound skips every instant the delay
      // genuinely clears in; with the shipped 24-hour contact delay it also
      // lands past the intent's own lifetime, so a Schedule click would come
      // back expired on the very next tick. A closed window is a fact. A delay
      // is a ceiling, and you find out it has lifted by asking.
      const fallback = now.getTime() + RECHECK_MS;
      const opensBy = settings
        ? nextWorkingInstant(new Date(fallback), settings)
        : null;
      const nextLook = Math.max(opensBy?.getTime() ?? fallback, fallback);
      // An instant the intent cannot live to is not a next look. Storing it
      // would leave `/outbound` with a "goes out" later than its own
      // "expires", keep the message out of the review queue until then, and
      // answer that promise on arrival by expiring the intent rather than
      // sending it. Hand the click back now instead, while the operator who
      // made it is still there — the same words the expiry branch uses,
      // carrying the refusal that outlasted it.
      if (row.expiresAt && nextLook >= row.expiresAt.getTime()) {
        await clearIntent(
          db,
          row.id,
          `This scheduled send expired before the policy allowed it: ${code}`,
        );
        outcomes.push({
          messageId: row.id,
          disposition: "expired",
          reason: code,
        });
        continue;
      }
      await db
        .update(messages)
        .set({ scheduledAt: new Date(nextLook) })
        .where(
          and(
            eq(messages.id, row.id),
            eq(messages.status, "approved"),
            isNotNull(messages.scheduledAt),
          ),
        );
      outcomes.push({
        messageId: row.id,
        disposition: "waiting",
        reason: code,
      });
      continue;
    }

    if (sent >= sendLimit) continue;
    // Take the intent before the send, in one conditional update.
    //
    // `sendApprovedMessage` consumes it inside its own claim, which is too
    // late to settle a race with the operator: a cancel landing between this
    // lane's read and that claim was answered "Scheduled send cancelled" and
    // the email went out anyway. Both statements are a row-level lock on the
    // same message now, so exactly one wins — either this finds nothing to
    // take and skips, or the cancel finds nothing to clear and says the send
    // is already on its way. One intent buys one attempt either way, which is
    // the rule the claim was already following.
    const [held] = await db
      .update(messages)
      .set({ scheduledAt: null, sendIntentExpiresAt: null })
      .where(
        and(
          eq(messages.id, row.id),
          eq(messages.status, "approved"),
          isNotNull(messages.scheduledAt),
        ),
      )
      .returning({ id: messages.id });
    if (!held) {
      outcomes.push({ messageId: row.id, disposition: "withdrawn" });
      continue;
    }
    sent += 1;
    const result = await send(row.id, now);
    outcomes.push({
      messageId: row.id,
      // Not `waiting`: the intent was taken above and nothing is waiting on it
      // any more. A send whose claim refused after this lane's own read said
      // yes leaves the message `approved` carrying the block's `lastError`, in
      // the review queue, for the operator to decide about again — which is
      // what "one intent buys one attempt" has always meant on every other
      // path through the claim.
      disposition: result.ok ? "sent" : "abandoned",
      ...(result.code ? { reason: result.code } : {}),
    });
  }
  return outcomes;
}

async function clearIntent(
  db: AppDatabase,
  messageId: string,
  lastError: string,
): Promise<void> {
  await db
    .update(messages)
    .set({ scheduledAt: null, sendIntentExpiresAt: null, lastError })
    .where(and(eq(messages.id, messageId), eq(messages.status, "approved")));
}
