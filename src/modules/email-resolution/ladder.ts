import { EMAIL_PATTERNS } from "@/modules/email-resolution/patterns";

/**
 * The arithmetic of the attempt ladder, with no database in it.
 *
 * A contact's ladder is the ordered list of addresses the evidence named for
 * them: rung one is the best-evidenced convention, later rungs are the others.
 * A one-rung ladder is a complete, valid state rather than a degraded one.
 *
 * Everything here is deliberately integer arithmetic and pure. The rules it
 * encodes decide whether a second message leaves the mailbox, so each one has to
 * be readable and testable on its own, without a fixture.
 */

/**
 * How far back the circuit breaker looks.
 *
 * A constant rather than a setting: the threshold is the judgement the operator
 * makes, and a window they could also change would let two numbers disagree
 * about what "the failure rate" means. Thirty days is long enough to contain a
 * month's sending at this product's volume and short enough that a fixed
 * convention stops being punished for a bad quarter.
 */
export const LADDER_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * How common a convention is, as a tiebreak between two equally evidenced ones.
 *
 * Derived from the pattern rather than stored, so any candidate row — including
 * one written by an earlier resolution, or by a demotion re-ranking months later
 * — can be placed in the same order without a column that could drift from
 * `inferEmailPatterns`, whose own tiebreak this is. An address with no
 * convention behind it sorts after every convention.
 */
export function conventionEvidenceOrder(pattern: string | null): number {
  if (pattern === null) return EMAIL_PATTERNS.length;
  const index = (EMAIL_PATTERNS as readonly string[]).indexOf(pattern);
  return index === -1 ? EMAIL_PATTERNS.length : index;
}

export type LadderRungInput = {
  normalizedEmail: string;
  /** The convention that produced it, or null for an address with no shape. */
  pattern: string | null;
  confidence: number;
  /**
   * Position in the ordering the evidence produced — `inferEmailPatterns`
   * returns conventions by sample count and then by how common the form is.
   *
   * Carried rather than recomputed because it is the tiebreak between two
   * equally evidenced conventions, and the alternative tiebreak the resolver
   * used to fall back on was the address in alphabetical order: a coin toss
   * dressed as a decision.
   */
  evidenceOrder: number;
};

export type LadderRung = LadderRungInput & {
  ladderRank: number;
  demoted: boolean;
  /**
   * Whether an adjacent rung is evidenced exactly as well as this one, in which
   * case the order between them is arbitrary.
   *
   * The product used to refuse such a pair outright, because one of two equally
   * evidenced addresses had to be picked and picking is a coin toss whose losing
   * side is a bounce. Under a ladder the loser is simply the next rung, so the
   * pair resolves — but the operator approving the message is now the only human
   * in front of an arbitrary choice, and they are owed the word "tied".
   */
  tiedWithNeighbour: boolean;
};

/**
 * Orders a contact's addresses into rungs.
 *
 * Demotion is the primary key, ahead of confidence, and that inversion is the
 * point: a convention with six public samples that has since been proven dead
 * for most of the people it was tried on at this company must rank below one with
 * two samples that has never failed. Its confidence is not touched — public
 * sample evidence and delivery outcome evidence stay two visible quantities,
 * because merging them is where a retroactive rescoring of addresses already sent
 * would get made silently.
 */
export function rankLadderRungs(
  rungs: LadderRungInput[],
  demotedPatterns: ReadonlySet<string>,
): LadderRung[] {
  const marked = rungs.map((rung) => ({
    ...rung,
    demoted: rung.pattern !== null && demotedPatterns.has(rung.pattern),
  }));
  const ordered = [...marked].sort(
    (left, right) =>
      Number(left.demoted) - Number(right.demoted) ||
      right.confidence - left.confidence ||
      left.evidenceOrder - right.evidenceOrder ||
      left.normalizedEmail.localeCompare(right.normalizedEmail),
  );
  return ordered.map((rung, index) => {
    const equallyEvidenced = (other: (typeof ordered)[number] | undefined) =>
      other !== undefined &&
      other.demoted === rung.demoted &&
      other.confidence === rung.confidence;
    return {
      ...rung,
      ladderRank: index + 1,
      tiedWithNeighbour:
        equallyEvidenced(ordered[index - 1]) ||
        equallyEvidenced(ordered[index + 1]),
    };
  });
}

export type LadderRungState = {
  normalizedEmail: string;
  ladderRank: number;
  firstAttemptedAt: Date | null;
  deadAt: Date | null;
  /** Whether an entry in the suppression list blocks this address. */
  suppressed: boolean;
};

export type NextRung =
  | { kind: "rung"; normalizedEmail: string; ladderRank: number }
  | {
      kind: "none";
      reason: "rung_ceiling" | "all_remaining_suppressed" | "no_remaining_rung";
    };

/**
 * The address to try next, or why there is not one.
 *
 * Only a never-attempted rung qualifies. An address that was attempted and is
 * not proven dead is not a rung waiting to be tried — it is the address in use,
 * and the person may be holding the message sent to it.
 *
 * The three refusals are kept apart because they call for different things from
 * the operator: a ceiling is a bound they can raise, a suppression is an entry
 * they can inspect and override, and an exhausted ladder is the end of the road
 * for this prospect.
 */
export function chooseNextRung(input: {
  rungs: LadderRungState[];
  maxRungs: number;
}): NextRung {
  // Dead counts as attempted even when the attempt clock was never stamped. A
  // recipient refusal discovered while resuming a draft proves the address does
  // not exist before the send transaction that stamps `firstAttemptedAt` is ever
  // reached — and a rung spent that way is still a rung spent. Counting only the
  // clock let a contact quietly exceed the ceiling.
  const attempted = input.rungs.filter(
    (rung) => rung.firstAttemptedAt !== null || rung.deadAt !== null,
  ).length;
  if (attempted >= input.maxRungs) {
    return { kind: "none", reason: "rung_ceiling" };
  }
  const remaining = input.rungs
    .filter((rung) => rung.firstAttemptedAt === null && rung.deadAt === null)
    .sort((left, right) => left.ladderRank - right.ladderRank);
  if (remaining.length === 0) {
    return { kind: "none", reason: "no_remaining_rung" };
  }
  const usable = remaining.find((rung) => !rung.suppressed);
  if (!usable) {
    return { kind: "none", reason: "all_remaining_suppressed" };
  }
  return {
    kind: "rung",
    normalizedEmail: usable.normalizedEmail,
    ladderRank: usable.ladderRank,
  };
}

/**
 * Whether one company's delivery record has discredited one convention.
 *
 * Two conditions, and the second is the one that makes the rule safe. A hard
 * bounce cannot distinguish a wrong address shape from a person who has left,
 * and contact discovery reads profiles of unknown age — so at a company with
 * stale data a share of every discovered set bounces on a perfectly correct
 * convention. Counting failures alone would demote true conventions most
 * aggressively exactly where discovery is weakest, which is a feedback loop that
 * learns fastest where the data is worst.
 *
 * Measured against attempts, never against deliveries: a send that produced no
 * failure says nothing about whether the address was right, so this can only ever
 * push a convention down the order. A convention rises only by acquiring more
 * public samples.
 */
export function isConventionDemoted(input: {
  peopleProvenDead: number;
  peopleAttempted: number;
  minimumPeople: number;
  failureSharePercent: number;
}): boolean {
  if (input.peopleProvenDead < input.minimumPeople) return false;
  if (input.peopleAttempted <= 0) return false;
  return (
    input.peopleProvenDead * 100 >=
    input.peopleAttempted * input.failureSharePercent
  );
}

/**
 * Whether the ladder should stop advancing entirely.
 *
 * The feature deliberately spends deliverability, so it needs a limit that is
 * visible and adjustable rather than implicit. The minimum sample is not a
 * detail: one failure out of one send is a hundred percent and means nothing,
 * and a breaker that trips on it would disable the feature on its first bounce.
 */
export function isLadderCircuitOpen(input: {
  sendsAttempted: number;
  sendsProvenDead: number;
  thresholdPercent: number;
  minimumSends: number;
}): boolean {
  if (input.sendsAttempted < input.minimumSends) return false;
  if (input.sendsAttempted <= 0) return false;
  return (
    input.sendsProvenDead * 100 >= input.sendsAttempted * input.thresholdPercent
  );
}
