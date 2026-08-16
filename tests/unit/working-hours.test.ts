import { describe, expect, it } from "vitest";

import {
  autoScheduleIntent,
  nextAttemptInstantFor,
  nextLegalSendInstant,
  scheduleOfferLabel,
  scheduledInstantLabel,
  shouldAutoSchedule,
} from "@/modules/messages/scheduled-send";
import {
  isWithinWorkingHours,
  nextWorkingInstant,
  operatorClock,
} from "@/modules/settings/working-hours";

const weekdays = {
  timezone: "Europe/Paris",
  workingDays: [1, 2, 3, 4, 5],
  workingStartMinute: 9 * 60,
  workingEndMinute: 18 * 60,
};

/** Paris local time, written as it reads on the operator's clock. */
const paris = (iso: string) => new Date(iso);

describe("when sending next becomes legal", () => {
  it("answers with the instant itself when the window is already open", () => {
    // Wednesday 10:00 Paris (UTC+2 in August).
    const now = paris("2026-08-12T08:00:00.000Z");
    expect(isWithinWorkingHours(now, weekdays)).toBe(true);
    expect(nextWorkingInstant(now, weekdays)).toEqual(now);
  });

  it("opens later the same day when the click lands before the window", () => {
    // Wednesday 07:00 Paris.
    const result = nextWorkingInstant(
      paris("2026-08-12T05:00:00.000Z"),
      weekdays,
    );
    // Wednesday 09:00 Paris.
    expect(result).toEqual(paris("2026-08-12T07:00:00.000Z"));
  });

  it("opens the next morning when the click lands after the window", () => {
    // Wednesday 18:01 Paris.
    const result = nextWorkingInstant(
      paris("2026-08-12T16:01:00.000Z"),
      weekdays,
    );
    // Thursday 09:00 Paris.
    expect(result).toEqual(paris("2026-08-13T07:00:00.000Z"));
  });

  // The case that makes "add a day" wrong. A refusal on Friday evening does not
  // open on Saturday, and the operator must not be told it does.
  it("crosses the weekend rather than promising tomorrow", () => {
    // Friday 18:05 Paris.
    const result = nextWorkingInstant(
      paris("2026-08-14T16:05:00.000Z"),
      weekdays,
    );
    // Monday 09:00 Paris — three days later.
    expect(result).toEqual(paris("2026-08-17T07:00:00.000Z"));
  });

  it("crosses a whole weekend from Saturday too", () => {
    // Saturday 11:00 Paris.
    const result = nextWorkingInstant(
      paris("2026-08-15T09:00:00.000Z"),
      weekdays,
    );
    expect(result).toEqual(paris("2026-08-17T07:00:00.000Z"));
  });

  // A calendar can be narrower than five days.
  it("skips several closed days in a row", () => {
    const mondayOnly = { ...weekdays, workingDays: [1] };
    // Tuesday 10:00 Paris — the day after the only open day.
    const result = nextWorkingInstant(
      paris("2026-08-11T08:00:00.000Z"),
      mondayOnly,
    );
    // The following Monday.
    expect(result).toEqual(paris("2026-08-17T07:00:00.000Z"));
  });

  // Daylight saving: Paris moves from UTC+2 to UTC+1 on 2026-10-25. A search
  // that added fixed 24-hour blocks would land an hour off.
  it("lands on the local hour across a daylight saving change", () => {
    // Friday 2026-10-23, 18:30 Paris (UTC+2).
    const result = nextWorkingInstant(
      paris("2026-10-23T16:30:00.000Z"),
      weekdays,
    );
    // Monday 2026-10-26, 09:00 Paris — now UTC+1, so 08:00 UTC.
    expect(result).toEqual(paris("2026-10-26T08:00:00.000Z"));
    expect(isWithinWorkingHours(result!, weekdays)).toBe(true);
  });

  it("respects a timezone other than the operator's default", () => {
    const tokyo = { ...weekdays, timezone: "Asia/Tokyo" };
    // Wednesday 07:00 Tokyo (UTC+9).
    const result = nextWorkingInstant(paris("2026-08-11T22:00:00.000Z"), tokyo);
    // Wednesday 09:00 Tokyo.
    expect(result).toEqual(paris("2026-08-12T00:00:00.000Z"));
  });

  // Not a failure to report as an error: there is genuinely no next slot, and
  // the caller has to say so rather than schedule against a calendar that never
  // opens.
  it("has no answer when no day is a working day", () => {
    expect(
      nextWorkingInstant(paris("2026-08-12T08:00:00.000Z"), {
        ...weekdays,
        workingDays: [],
      }),
    ).toBeNull();
  });

  it("has no answer beyond the search horizon", () => {
    expect(
      nextWorkingInstant(paris("2026-08-14T16:05:00.000Z"), weekdays, {
        horizonMs: 60_000,
      }),
    ).toBeNull();
  });

  // Whatever the search returns has to satisfy the same predicate the send
  // policy applies, or the schedule promises a slot the policy will refuse.
  it("only ever returns an instant the policy would accept", () => {
    const starts = [
      "2026-08-14T16:05:00.000Z",
      "2026-08-15T09:00:00.000Z",
      "2026-08-12T05:00:00.000Z",
      "2026-10-23T16:30:00.000Z",
      "2026-12-31T23:30:00.000Z",
    ];
    for (const start of starts) {
      const result = nextWorkingInstant(paris(start), weekdays);
      expect(result).not.toBeNull();
      expect(isWithinWorkingHours(result!, weekdays)).toBe(true);
      expect(result!.getTime()).toBeGreaterThanOrEqual(paris(start).getTime());
    }
  });
});

// The send notice, the review card and the schedule button all print the same
// instant, and each used to carry its own copy of how. The rule below is what
// they now share.
describe("an instant on the operator's clock", () => {
  // Monday 09:00 Paris. Announced as 07:00 UTC it is a different working day
  // to anyone reading it, which is what the schema column warns about in so
  // many words.
  const mondayMorning = paris("2026-08-17T07:00:00.000Z");

  it("names the operator's hour and the zone it belongs to", () => {
    const rendered = operatorClock(mondayMorning, "Europe/Paris");
    expect(rendered).toContain("9:00");
    expect(rendered).not.toContain("7:00");
    expect(rendered).toContain("CEST");
  });

  it("follows the configured zone rather than the host's", () => {
    expect(operatorClock(mondayMorning, "Asia/Tokyo")).toContain("16:00");
  });

  // Winter, so the same wall-clock hour sits at a different UTC offset. A
  // renderer that had cached an offset would say 10:00 here.
  it("re-reads the offset instead of carrying one", () => {
    const january = paris("2027-01-18T08:00:00.000Z");
    const rendered = operatorClock(january, "Europe/Paris");
    expect(rendered).toContain("9:00");
    expect(rendered).toContain("CET");
  });

  // Only reachable before any sending settings exist. Falling back to the
  // host's clock is the honest answer; inventing UTC and calling it the
  // operator's would not be.
  it("falls back to the host clock when nothing is configured", () => {
    expect(operatorClock(mondayMorning)).not.toBe("");
  });
});

// What a standing intent says about itself. The instant it carries is a
// delivery time when the calendar is what stood in the way, and only the lane's
// next look when a delay is — and those two must not be printed the same way.
describe("what a standing intent announces", () => {
  const now = paris("2026-08-17T12:00:00.000Z"); // Monday 14:00 Paris.

  it("names a real slot, on the operator's clock", () => {
    const label = scheduledInstantLabel(
      paris("2026-08-18T07:00:00.000Z"), // Tuesday 09:00 Paris.
      now,
      "Europe/Paris",
    );
    expect(label).toContain("18/08/2026");
    expect(label).toContain("9:00");
    expect(label).toContain("CEST");
  });

  // The case this exists for. A refusal on a delay stores the next look, five
  // minutes out; printed as an instant it reads "goes out in 5 minutes" for up
  // to a day, which is not vagueness, it is an imminent send nobody asked for.
  it("refuses to print a next look as a delivery time", () => {
    expect(
      scheduledInstantLabel(new Date(now.getTime() + 5 * 60_000), now, "UTC"),
    ).toBe("the first instant the policy allows");
  });

  // The instant a click has just written, before the lane has looked once. It
  // is in the past by the time any page renders it.
  it("says the same of an instant already behind us", () => {
    expect(
      scheduledInstantLabel(new Date(now.getTime() - 60_000), now, "UTC"),
    ).toBe("the first instant the policy allows");
  });

  it("draws the line where the lane's own cadence ends", () => {
    const cadence = new Date(now.getTime() + 5 * 60_000);
    const beyond = new Date(cadence.getTime() + 1);
    expect(scheduledInstantLabel(cadence, now, "UTC")).not.toContain("2026");
    expect(scheduledInstantLabel(beyond, now, "UTC")).toContain("2026");
  });

  // The card puts this after "Scheduled for", so the phrase has to be a noun
  // the sentence can take. It is the wording that is under test here, not the
  // branch — the branch is the one above.
  it("composes after “Scheduled for”", () => {
    const label = scheduledInstantLabel(now, now, "Europe/Paris");
    expect(`Scheduled for ${label}`).toBe(
      "Scheduled for the first instant the policy allows",
    );
  });
});

describe("how far away a transient refusal is", () => {
  const settings = {
    ...weekdays,
    mailboxMinimumDelaySeconds: 60,
    contactMinimumDelayMinutes: 5,
  };
  // Friday 18:05 Paris.
  const fridayEvening = paris("2026-08-14T16:05:00.000Z");
  // Wednesday 10:00 Paris, inside the window.
  const midWeek = paris("2026-08-12T08:00:00.000Z");

  it("measures the pacing delays from the settings, not from the calendar", () => {
    // Inside working hours the calendar would answer "now" for both of these,
    // which is why the calendar is not what is consulted.
    expect(
      nextAttemptInstantFor("MAILBOX_MINIMUM_DELAY", midWeek, settings),
    ).toEqual(new Date(midWeek.getTime() + 60_000));
    expect(
      nextAttemptInstantFor("CONTACT_MINIMUM_DELAY", midWeek, settings),
    ).toEqual(new Date(midWeek.getTime() + 5 * 60_000));
  });

  it("measures a closed window against the calendar, weekend included", () => {
    expect(
      nextAttemptInstantFor("OUTSIDE_WORKING_HOURS", fridayEvening, settings),
    ).toEqual(paris("2026-08-17T07:00:00.000Z"));
  });

  // A rolling 24-hour cap has no instant the settings can name. Answering
  // "now" because the calendar is open would commit the operator to a day of
  // waiting they never saw.
  it("has no answer for a daily cap", () => {
    expect(
      nextAttemptInstantFor("MAILBOX_DAILY_CAP_REACHED", midWeek, settings),
    ).toBeNull();
    expect(
      nextAttemptInstantFor("CAMPAIGN_DAILY_CAP_REACHED", midWeek, settings),
    ).toBeNull();
  });

  it("takes on a close wait and asks about a distant one", () => {
    // The sixty-second pacing delay: nobody wants to think about it.
    expect(
      shouldAutoSchedule(
        nextAttemptInstantFor("MAILBOX_MINIMUM_DELAY", midWeek, settings),
        midWeek,
      ),
    ).toBe(true);
    // Friday evening to Monday morning: that is a decision, not a detail.
    expect(
      shouldAutoSchedule(
        nextAttemptInstantFor("OUTSIDE_WORKING_HOURS", fridayEvening, settings),
        fridayEvening,
      ),
    ).toBe(false);
    // An unknown wait is never taken on silently.
    expect(shouldAutoSchedule(null, midWeek)).toBe(false);
  });

  it("draws the line at an hour, on both sides", () => {
    const justInside = new Date(midWeek.getTime() + 60 * 60_000);
    const justOutside = new Date(midWeek.getTime() + 60 * 60_000 + 1);
    expect(shouldAutoSchedule(justInside, midWeek)).toBe(true);
    expect(shouldAutoSchedule(justOutside, midWeek)).toBe(false);
  });

  // The delay the settings name is not the same thing as the instant a send
  // could actually leave, and at the end of the day they are a night apart.
  describe("and when it could actually leave", () => {
    // Monday 17:59:30 Paris: the sixty-second pacing delay ends at 18:00:30,
    // which is after the window shuts.
    const lateMonday = paris("2026-08-17T15:59:30.000Z");

    it("adds the calendar on top of the delay", () => {
      expect(
        nextAttemptInstantFor("MAILBOX_MINIMUM_DELAY", lateMonday, settings),
      ).toEqual(paris("2026-08-17T16:00:30.000Z"));
      // Tuesday 09:00 Paris. The search jumps in whole minutes, so it carries
      // the seconds of what it was given — the answer is the opening, to the
      // second the delay ended on.
      expect(
        nextLegalSendInstant("MAILBOX_MINIMUM_DELAY", lateMonday, settings),
      ).toEqual(paris("2026-08-18T07:00:30.000Z"));
    });

    // Read from the bare delay this answers "a minute" and the send button
    // takes it on, which turns a click nobody would think twice about into
    // tomorrow morning's unattended send.
    it("refuses to take on a minute that lands after the window shuts", () => {
      expect(
        shouldAutoSchedule(
          nextLegalSendInstant("MAILBOX_MINIMUM_DELAY", lateMonday, settings),
          lateMonday,
        ),
      ).toBe(false);
    });

    it("still takes on the same delay in the middle of the day", () => {
      const instant = nextLegalSendInstant(
        "MAILBOX_MINIMUM_DELAY",
        midWeek,
        settings,
      );
      expect(instant).toEqual(new Date(midWeek.getTime() + 60_000));
      expect(shouldAutoSchedule(instant, midWeek)).toBe(true);
    });

    it("has no more of an answer than the delay did for a cap", () => {
      expect(
        nextLegalSendInstant("MAILBOX_DAILY_CAP_REACHED", midWeek, settings),
      ).toBeNull();
    });
  });

  // What the send button does with a refusal, as one rule rather than three
  // expressions in a route that have to agree with each other. They are not
  // independent: the hour of lifetime is granted *because* the instant was
  // within the hour, so an instant read one way and a lifetime read another is
  // how a minute's wait acquires a night's licence to send.
  describe("and what the send button does with it", () => {
    it("takes on a delay that clears inside the window, with the lifetime it was promised under", () => {
      expect(
        autoScheduleIntent("MAILBOX_MINIMUM_DELAY", midWeek, settings),
      ).toEqual({
        notBefore: new Date(midWeek.getTime() + 60_000),
        lifetimeMs: 60 * 60_000,
      });
    });

    // The 2026-08-14 incident with a schedule in front of it: read from the
    // bare delay this is "a minute", and the button takes it on unattended.
    it("declines the same delay when a minute later is tomorrow", () => {
      expect(
        autoScheduleIntent(
          "MAILBOX_MINIMUM_DELAY",
          paris("2026-08-17T15:59:30.000Z"),
          settings,
        ),
      ).toBeNull();
    });

    it("declines a Friday-evening click that would leave on Monday", () => {
      expect(
        autoScheduleIntent("OUTSIDE_WORKING_HOURS", fridayEvening, settings),
      ).toBeNull();
    });

    // No nameable end, so no promise the hour of lifetime could be measured
    // against. The card offers it instead, and the operator chooses the day.
    it("declines a cap it cannot name an end for", () => {
      expect(
        autoScheduleIntent("MAILBOX_DAILY_CAP_REACHED", midWeek, settings),
      ).toBeNull();
    });

    // Pins the behaviour, not the line that produces it. Today the
    // `isTransientSendBlock` guard in `autoScheduleIntent` is redundant —
    // these codes name no instant either, so the null already declines them —
    // and removing it leaves this green. It is kept because it states the rule
    // the same way `scheduleOfferLabel` does, where the same guard *is*
    // load-bearing; what must never change is the answer below.
    it("declines a refusal time does not lift", () => {
      expect(
        autoScheduleIntent("RECIPIENT_SUPPRESSED", midWeek, settings),
      ).toBeNull();
      expect(
        autoScheduleIntent("EMERGENCY_PAUSED", midWeek, settings),
      ).toBeNull();
      expect(autoScheduleIntent("REPLY_PENDING", midWeek, settings)).toBeNull();
    });
  });
});

// What the review card offers, decided outside the page so the rule is
// reachable by something other than a browser run.
describe("the schedule this card offers", () => {
  const settings = {
    ...weekdays,
    mailboxMinimumDelaySeconds: 60,
    contactMinimumDelayMinutes: 5,
  };
  const fridayEvening = paris("2026-08-14T16:05:00.000Z");
  const midWeek = paris("2026-08-12T08:00:00.000Z");

  it("offers nothing when the send would go out now", () => {
    expect(scheduleOfferLabel({ ok: true }, midWeek, settings)).toBeNull();
  });

  it("offers nothing for a refusal waiting cannot lift", () => {
    for (const code of ["UNSUBSCRIBED", "EMERGENCY_PAUSED", "REPLY_PENDING"]) {
      expect(
        scheduleOfferLabel({ ok: false, code }, midWeek, settings),
      ).toBeNull();
    }
  });

  it("offers nothing for a wait the send button already took on", () => {
    expect(
      scheduleOfferLabel(
        { ok: false, code: "MAILBOX_MINIMUM_DELAY" },
        midWeek,
        settings,
      ),
    ).toBeNull();
  });

  it("names the instant when it can, in the operator's timezone", () => {
    const label = scheduleOfferLabel(
      { ok: false, code: "OUTSIDE_WORKING_HOURS" },
      fridayEvening,
      settings,
    );
    expect(label).toContain("Schedule for");
    expect(label).toContain("17/08/2026");
    // Monday 9:00 as the operator's clock reads it, not 7:00 UTC. The zone is
    // named so the string cannot be mistaken for either.
    expect(label).toContain("9:00");
    expect(label).not.toContain("7:00");
    expect(label).toContain("CEST");
  });

  // The case the send notice used to point at and the card never rendered.
  it("still offers when the wait has no nameable end", () => {
    expect(
      scheduleOfferLabel(
        { ok: false, code: "MAILBOX_DAILY_CAP_REACHED" },
        midWeek,
        settings,
      ),
    ).toBe("Schedule — it goes out when the cap clears");
  });

  it("offers nothing once an intent is already standing", () => {
    expect(
      scheduleOfferLabel(
        { ok: false, code: "OUTSIDE_WORKING_HOURS" },
        fridayEvening,
        settings,
        { alreadyScheduled: true },
      ),
    ).toBeNull();
  });

  // The verdict is rendered for `drafted` cards too — the policy accepts that
  // status — and `drafted` is exactly where a send refused at the final check
  // lands, which is the 17:59/18:00 case this lane was built around. An intent
  // can only be written for an `approved` message, so offering there rendered
  // a button whose route answered "no longer waiting to be sent".
  it("offers nothing on a card no intent can be written for", () => {
    expect(
      scheduleOfferLabel(
        { ok: false, code: "OUTSIDE_WORKING_HOURS" },
        fridayEvening,
        settings,
        { schedulable: false },
      ),
    ).toBeNull();
    expect(
      scheduleOfferLabel(
        { ok: false, code: "OUTSIDE_WORKING_HOURS" },
        fridayEvening,
        settings,
        { schedulable: true },
      ),
    ).toContain("Schedule for");
  });

  // The send button declines a pacing delay that lands after the window, so
  // the card has to pick it up — naming the morning it actually opens, not the
  // minute the delay itself ends.
  it("offers the morning for a pacing delay that lands after the window", () => {
    const label = scheduleOfferLabel(
      { ok: false, code: "MAILBOX_MINIMUM_DELAY" },
      paris("2026-08-17T15:59:30.000Z"),
      settings,
    );
    expect(label).toContain("18/08/2026");
    expect(label).toContain("9:00");
  });
});
