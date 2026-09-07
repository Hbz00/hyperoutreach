import { expect, it } from "vitest";

import {
  isWithinWorkingHours,
  nextWorkingInstant,
} from "@/modules/settings/working-hours";

it.each([
  {
    name: "the short Sunday window after the spring clock change",
    now: "2026-03-28T23:00:00.000Z",
    start: 9 * 60,
    end: 9 * 60 + 30,
    expected: "2026-03-29T07:00:00.000Z",
  },
  {
    name: "the repeated Sunday window after the autumn clock change",
    now: "2026-10-25T00:45:00.000Z",
    start: 2 * 60,
    end: 2 * 60 + 30,
    expected: "2026-10-25T01:00:00.000Z",
  },
  {
    name: "the first occurrence when the autumn window has not opened",
    now: "2026-10-24T23:45:00.000Z",
    start: 2 * 60,
    end: 2 * 60 + 30,
    expected: "2026-10-25T00:00:00.000Z",
  },
  {
    name: "the next Sunday when the spring window does not exist",
    now: "2026-03-28T23:00:00.000Z",
    start: 2 * 60,
    end: 2 * 60 + 30,
    expected: "2026-04-05T00:00:00.000Z",
  },
])("finds $name", ({ now, start, end, expected }) => {
  const settings = {
    timezone: "Europe/Paris",
    workingDays: [0],
    workingStartMinute: start,
    workingEndMinute: end,
  };
  const opening = new Date(expected);
  expect(isWithinWorkingHours(new Date(now), settings)).toBe(false);
  expect(isWithinWorkingHours(opening, settings)).toBe(true);
  expect(isWithinWorkingHours(new Date(opening.getTime() - 1), settings)).toBe(
    false,
  );
  expect(nextWorkingInstant(new Date(now), settings)).toEqual(opening);
  expect(
    nextWorkingInstant(new Date(now), settings, {
      horizonMs: opening.getTime() - new Date(now).getTime() - 1,
    }),
  ).toBeNull();
});
