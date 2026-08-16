export type WorkingHours = {
  timezone: string;
  workingDays: number[];
  workingStartMinute: number;
  workingEndMinute: number;
};

/**
 * Formatters are expensive to build and there is one timezone in practice, so
 * they are kept. The search below asks for a local position several times per
 * call; building a formatter each time made a cheap calculation quadratic in
 * nothing at all.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timezone, formatter);
  return formatter;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Where an instant falls in the operator's local week.
 *
 * The single place that maps a UTC instant onto a weekday and a minute of the
 * day. Both the "is it open now" predicate and the "when does it next open"
 * search read from here, so they cannot disagree about what Monday means.
 */
export function localWorkingPosition(
  now: Date,
  settings: Pick<WorkingHours, "timezone">,
): { day: number; minute: number } | null {
  const parts = formatterFor(settings.timezone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const day = WEEKDAYS[part("weekday")];
  if (day === undefined) return null;
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { day, minute: hour * 60 + minute };
}

export function isWithinWorkingHours(
  now: Date,
  settings: WorkingHours,
): boolean {
  const position = localWorkingPosition(now, settings);
  if (!position) return false;
  return (
    settings.workingDays.includes(position.day) &&
    position.minute >= settings.workingStartMinute &&
    position.minute < settings.workingEndMinute
  );
}

const MINUTE_MS = 60_000;
/** A week plus a day, so a search that starts mid-week still sees every day. */
const SEARCH_HORIZON_MS = 8 * 24 * 60 * MINUTE_MS;

/**
 * The first instant at or after `now` when sending is allowed, or `null` when
 * no such instant exists inside a week.
 *
 * "Outside the sending window" does not mean "tomorrow". With the shipped
 * Monday-to-Friday default, a refusal at 18:00 on Friday next opens on Monday
 * morning — three days later, across a weekend, and possibly across a daylight
 * saving change. Anything built on "add a day" would promise a slot that is not
 * one.
 *
 * The search jumps rather than steps: to the start of the window when today is
 * a working day that has not opened yet, otherwise to the next local midnight.
 * Each jump re-derives the local position from the resulting instant, so a
 * daylight saving shift is absorbed by the next iteration instead of skewing
 * the answer. The result is verified against the same predicate the send policy
 * uses before it is returned — a search that cannot prove its own answer
 * returns nothing rather than a plausible wrong instant.
 *
 * `null` is a real answer, not a failure: an operator whose calendar has no
 * working days has no next slot, and promising one would be a lie.
 */
export function nextWorkingInstant(
  now: Date,
  settings: WorkingHours,
  options: { horizonMs?: number } = {},
): Date | null {
  if (settings.workingDays.length === 0) return null;
  if (settings.workingStartMinute >= settings.workingEndMinute) return null;
  if (isWithinWorkingHours(now, settings)) return now;

  const horizon = now.getTime() + (options.horizonMs ?? SEARCH_HORIZON_MS);
  let cursor = now;
  // One iteration per day boundary crossed, plus one for the opening jump.
  for (let step = 0; step < 20; step += 1) {
    if (cursor.getTime() > horizon) return null;
    const position = localWorkingPosition(cursor, settings);
    if (!position) return null;
    const opensToday =
      settings.workingDays.includes(position.day) &&
      position.minute < settings.workingStartMinute;
    const jumpMinutes = opensToday
      ? settings.workingStartMinute - position.minute
      : 24 * 60 - position.minute;
    const candidate = new Date(cursor.getTime() + jumpMinutes * MINUTE_MS);
    if (isWithinWorkingHours(candidate, settings)) {
      return candidate.getTime() > horizon ? null : candidate;
    }
    cursor = candidate;
  }
  return null;
}

/**
 * An instant as the operator reads it: their configured clock, named.
 *
 * A slot computed against a 09:00 calendar must never be announced as 07:00
 * UTC — the point of a scheduled send is that the operator recognises the hour
 * it names. Three places print the same instant (the send notice, the review
 * card, the label on the schedule button), and until they shared this they
 * carried three copies of the same locale, the same options and the same
 * intent, any one of which could have drifted.
 *
 * `timezone` is optional only because a page can, in principle, render before
 * any sending settings exist; there is no invented default, just the host's
 * own clock, which is the honest answer when nothing has been configured.
 */
export function operatorClock(instant: Date, timezone?: string): string {
  return instant.toLocaleString("en-GB", {
    ...(timezone ? { timeZone: timezone } : {}),
    timeZoneName: "short",
  });
}
