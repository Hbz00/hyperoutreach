import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A settings control that the route does not read is worse than a missing one.
 *
 * The operator changes it, the page answers "Sending policy updated", and
 * nothing happened — there is no error to notice and no way to tell from the
 * screen. Seven ladder fields shipped in exactly that state: rendered on the
 * form, present in the update schema, and read by nobody.
 *
 * This compares the two ends of the wire as source text, in the same spirit as
 * the client/provider boundary test: the form's field names against the fields
 * the `update-settings` handler passes to the service. It is deliberately
 * dumber than parsing JSX — a name that appears in neither place cannot be
 * silently dropped by a clever matcher.
 */
const settingsPage = resolve(
  process.cwd(),
  "src/app/(operator)/settings/page.tsx",
);
const commandRoute = resolve(
  process.cwd(),
  "src/app/api/operator/commands/[command]/route.ts",
);

/** The `name="…"` of every control inside the sending-policy form. */
async function sendingPolicyFieldNames(): Promise<string[]> {
  const source = await readFile(settingsPage, "utf8");
  const start = source.indexOf(
    'action="/api/operator/commands/update-settings"',
  );
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("</form>", start);
  expect(end).toBeGreaterThan(start);
  const form = source.slice(start, end);
  return [
    ...new Set([...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1]!)),
  ].filter((name) => name !== "csrf");
}

async function updateSettingsHandler(): Promise<string> {
  const source = await readFile(commandRoute, "utf8");
  const start = source.indexOf('if (command === "update-settings")');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("if (command ===", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("sending policy form wiring", () => {
  it("reads every control the sending-policy form renders", async () => {
    const names = await sendingPolicyFieldNames();
    const handler = await updateSettingsHandler();
    expect(names.length).toBeGreaterThan(10);
    const unread = names.filter((name) => !handler.includes(`"${name}"`));
    expect(unread).toEqual([]);
  });

  it("renders every ladder bound the schema accepts", async () => {
    const names = await sendingPolicyFieldNames();
    // Named explicitly rather than derived from the schema: the point is that a
    // bound the operator cannot see is as broken as one they cannot change, and
    // deriving both ends from the same file would prove neither.
    expect(names).toEqual(
      expect.arrayContaining([
        "addressLadderEnabled",
        "addressLadderMaxRungs",
        "addressLadderMaxAdvancesPerAccountPerDay",
        "addressLadderFailureRatePercent",
        "addressLadderFailureRateMinimumSends",
        "addressLadderDemotionMinimumPeople",
        "addressLadderDemotionFailureSharePercent",
      ]),
    );
  });

  it("keeps the ladder switch turnable off, not only on", async () => {
    const handler = await updateSettingsHandler();
    // An unchecked checkbox is not submitted, so the switch can only be turned
    // off by a reader that treats an absent field as false. `value()` would
    // return undefined and the schema would leave the setting untouched.
    expect(handler).toContain('boolean(formData, "addressLadderEnabled")');
  });
});
