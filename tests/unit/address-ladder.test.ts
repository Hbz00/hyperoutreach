import { describe, expect, it } from "vitest";

import { describeResolutionReason } from "@/modules/presentation/status";
import {
  chooseNextRung,
  isConventionDemoted,
  isLadderCircuitOpen,
  rankLadderRungs,
  type LadderRungState,
} from "@/modules/email-resolution/ladder";

describe("rankLadderRungs", () => {
  it("orders by confidence, then by the evidence ordering, never alphabetically", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "z.a@acme.test",
          pattern: "flast",
          confidence: 0.9,
          evidenceOrder: 1,
        },
        {
          normalizedEmail: "a.z@acme.test",
          pattern: "first.last",
          confidence: 0.9,
          evidenceOrder: 0,
        },
      ],
      new Set(),
    );
    expect(ranked.map((rung) => rung.normalizedEmail)).toEqual([
      "a.z@acme.test",
      "z.a@acme.test",
    ]);
    expect(ranked.map((rung) => rung.ladderRank)).toEqual([1, 2]);
    // Equally evidenced: the order between them is arbitrary and says so.
    expect(ranked.map((rung) => rung.tiedWithNeighbour)).toEqual([true, true]);
  });

  it("puts a demoted convention behind a worse-evidenced one it used to outrank", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "best@acme.test",
          pattern: "first.last",
          confidence: 0.97,
          evidenceOrder: 0,
        },
        {
          normalizedEmail: "weak@acme.test",
          pattern: "flast",
          confidence: 0.75,
          evidenceOrder: 1,
        },
      ],
      new Set(["first.last"]),
    );
    expect(ranked.map((rung) => rung.normalizedEmail)).toEqual([
      "weak@acme.test",
      "best@acme.test",
    ]);
    expect(ranked.map((rung) => rung.demoted)).toEqual([false, true]);
  });

  it("leaves the confidence a demotion reorders around untouched", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "best@acme.test",
          pattern: "first.last",
          confidence: 0.97,
          evidenceOrder: 0,
        },
      ],
      new Set(["first.last"]),
    );
    expect(ranked[0]?.confidence).toBe(0.97);
    expect(ranked[0]?.ladderRank).toBe(1);
  });

  it("does not mark a strictly better-evidenced rung as tied", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "a@acme.test",
          pattern: "first.last",
          confidence: 0.97,
          evidenceOrder: 0,
        },
        {
          normalizedEmail: "b@acme.test",
          pattern: "flast",
          confidence: 0.75,
          evidenceOrder: 1,
        },
      ],
      new Set(),
    );
    expect(ranked.map((rung) => rung.tiedWithNeighbour)).toEqual([
      false,
      false,
    ]);
  });

  it("does not tie a demoted rung to an undemoted one that happens to score the same", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "a@acme.test",
          pattern: "first.last",
          confidence: 0.9,
          evidenceOrder: 0,
        },
        {
          normalizedEmail: "b@acme.test",
          pattern: "flast",
          confidence: 0.9,
          evidenceOrder: 1,
        },
      ],
      new Set(["first.last"]),
    );
    expect(ranked.map((rung) => rung.normalizedEmail)).toEqual([
      "b@acme.test",
      "a@acme.test",
    ]);
    expect(ranked.map((rung) => rung.tiedWithNeighbour)).toEqual([
      false,
      false,
    ]);
  });

  it("ranks an unpatterned address without treating it as a convention", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "provider@acme.test",
          pattern: null,
          confidence: 0.9,
          evidenceOrder: 99,
        },
      ],
      new Set(["first.last"]),
    );
    expect(ranked[0]).toMatchObject({ ladderRank: 1, demoted: false });
  });
});

describe("chooseNextRung", () => {
  const rung = (
    over: Partial<LadderRungState> & {
      normalizedEmail: string;
      ladderRank: number;
    },
  ): LadderRungState => ({
    firstAttemptedAt: null,
    deadAt: null,
    suppressed: false,
    ...over,
  });

  it("returns the lowest-ranked rung that was never attempted", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({ normalizedEmail: "two@a.test", ladderRank: 2 }),
          rung({ normalizedEmail: "three@a.test", ladderRank: 3 }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "rung", normalizedEmail: "two@a.test", ladderRank: 2 });
  });

  it("counts the ceiling in addresses attempted, not advances taken", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({
            normalizedEmail: "two@a.test",
            ladderRank: 2,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({ normalizedEmail: "three@a.test", ladderRank: 3 }),
        ],
        maxRungs: 2,
      }),
    ).toEqual({ kind: "none", reason: "rung_ceiling" });
  });

  it("distinguishes an exhausted ladder from one blocked by a suppression", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "none", reason: "no_remaining_rung" });

    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({
            normalizedEmail: "two@a.test",
            ladderRank: 2,
            suppressed: true,
          }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "none", reason: "all_remaining_suppressed" });
  });

  it("skips a suppressed rung for a usable one behind it", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({
            normalizedEmail: "two@a.test",
            ladderRank: 2,
            suppressed: true,
          }),
          rung({ normalizedEmail: "three@a.test", ladderRank: 3 }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "rung", normalizedEmail: "three@a.test", ladderRank: 3 });
  });

  it("never returns a rung that was already attempted but is not proven dead", () => {
    // Nothing proved that address wrong, so it is not a rung to try again — it
    // is the address in use.
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
          }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "none", reason: "no_remaining_rung" });
  });
});

describe("isConventionDemoted", () => {
  const rule = { minimumPeople: 2, failureSharePercent: 50 };

  it("never demotes on one person, whatever the share", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 1,
        peopleAttempted: 1,
        ...rule,
      }),
    ).toBe(false);
  });

  it("does not demote a correct convention at a company with stale contact data", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 3,
        peopleAttempted: 10,
        ...rule,
      }),
    ).toBe(false);
  });

  it("demotes a convention that fails for most of the people it was tried on", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 3,
        peopleAttempted: 4,
        ...rule,
      }),
    ).toBe(true);
  });

  it("treats the share as inclusive at exactly the threshold", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 2,
        peopleAttempted: 4,
        ...rule,
      }),
    ).toBe(true);
  });

  it("cannot be demoted by failures nobody attempted", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 0,
        peopleAttempted: 0,
        ...rule,
      }),
    ).toBe(false);
  });
});

describe("isLadderCircuitOpen", () => {
  const rule = { thresholdPercent: 30, minimumSends: 20 };

  it("stays closed below the minimum sample, however bad the share", () => {
    expect(
      isLadderCircuitOpen({ sendsAttempted: 1, sendsProvenDead: 1, ...rule }),
    ).toBe(false);
  });

  it("opens once an adequate sample reaches the threshold", () => {
    expect(
      isLadderCircuitOpen({ sendsAttempted: 20, sendsProvenDead: 6, ...rule }),
    ).toBe(true);
    expect(
      isLadderCircuitOpen({ sendsAttempted: 20, sendsProvenDead: 5, ...rule }),
    ).toBe(false);
  });

  it("is closed when nothing has been sent at all", () => {
    expect(
      isLadderCircuitOpen({ sendsAttempted: 0, sendsProvenDead: 0, ...rule }),
    ).toBe(false);
  });
});

describe("every ladder outcome the operator can read", () => {
  /**
   * A reason with no sentence renders as its own enum value. That is survivable
   * for an internal audit label and not for these: each one exists precisely
   * because the operator has to know which of them they are looking at, and
   * `ladder_earlier_send_unconfirmed` shipped without a sentence once already.
   */
  it("has a sentence rather than an enum value", () => {
    for (const reason of [
      "ladder_exhausted",
      "ladder_limit_reached",
      "ladder_earlier_send_unconfirmed",
      "address_suppressed",
    ]) {
      const described = describeResolutionReason(reason);
      expect(described).not.toBe(reason);
      expect(described).toMatch(/[a-z] [a-z]/);
    }
  });
});
