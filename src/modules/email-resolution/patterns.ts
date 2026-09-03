import {
  normalizeDomain,
  normalizeEmail,
} from "@/modules/prospects/normalization";

export const EMAIL_PATTERNS = [
  "first.last",
  "firstlast",
  "f.last",
  "flast",
  "last.first",
  "first_last",
  "first-last",
] as const;

export type EmailPattern = (typeof EMAIL_PATTERNS)[number];

const transliterations: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};

/** Case, transliteration and accents — everything except the separator. */
function foldNamePart(value: string): string {
  return [...value.toLocaleLowerCase("en-US")]
    .map((character) => transliterations[character] ?? character)
    .join("")
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "");
}

function trimSeparators(value: string): string {
  const normalized = value.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Name cannot produce an email local part");
  return normalized;
}

/**
 * A name part as an email local part, keeping a hyphen the name itself has.
 *
 * This used to drop it, and that was never evidence — it was the default nobody
 * had a reason to question until delivery gave one. "Pierre-Yves Gudefin" at
 * fedex.com is `pierre-yves.gudefin`, verified by the operator against a
 * third-party directory, while Hyperoutreach had accepted
 * `pierreyves.gudefin` at 0.970 confidence.
 *
 * Only a hyphen, and only one the name already contains. A space is not
 * promoted to a separator — "Le Roué" stays `leroue`, because inventing
 * punctuation is a different and unevidenced claim — and an apostrophe is still
 * dropped, deliberately out of scope. The collapsed spelling is not lost: it
 * becomes the next rung of the ladder, so a wrong guess costs one bounce and
 * corrects itself.
 */
export function normalizeEmailNamePart(value: string): string {
  return trimSeparators(foldNamePart(value).replace(/[^a-z0-9-]+/g, ""));
}

/**
 * The same name part with every separator removed.
 *
 * What this module produced before hyphens were kept, so every address already
 * stored was produced by it — and what the ladder tries next when the
 * hyphenated spelling is not what the company does.
 */
export function collapsedEmailNamePart(value: string): string {
  return trimSeparators(foldNamePart(value).replace(/[^a-z0-9]+/g, ""));
}

/** Whether this name is written differently under the two renderings. */
export function hasDistinctCollapsedForm(
  firstName: string,
  lastName: string,
): boolean {
  try {
    return (
      normalizeEmailNamePart(firstName) !== collapsedEmailNamePart(firstName) ||
      normalizeEmailNamePart(lastName) !== collapsedEmailNamePart(lastName)
    );
  } catch {
    return false;
  }
}

export type NameRendering = "hyphenated" | "collapsed";

function localPartForPattern(
  firstName: string,
  lastName: string,
  pattern: EmailPattern,
  rendering: NameRendering = "hyphenated",
): string {
  const render =
    rendering === "collapsed" ? collapsedEmailNamePart : normalizeEmailNamePart;
  const first = render(firstName);
  const last = render(lastName);
  const firstInitial = first[0];
  if (!firstInitial) throw new Error("First name is required");
  switch (pattern) {
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "f.last":
      return `${firstInitial}.${last}`;
    case "flast":
      return `${firstInitial}${last}`;
    case "last.first":
      return `${last}.${first}`;
    case "first_last":
      return `${first}_${last}`;
    case "first-last":
      return `${first}-${last}`;
  }
}

export function generateCandidateAddress(input: {
  firstName: string;
  lastName: string;
  domain: string;
  pattern: EmailPattern;
  /** Defaults to keeping a hyphen the name contains. */
  rendering?: NameRendering;
}): string {
  return normalizeEmail(
    `${localPartForPattern(input.firstName, input.lastName, input.pattern, input.rendering)}@${normalizeDomain(input.domain)}`,
  );
}

export type PublicEmailSample = {
  firstName: string;
  lastName: string;
  email: string;
  sourceUrl: string;
};

/**
 * What one public sample said about the company's convention.
 *
 * Three answers, and the middle one is the reason this type exists.
 * `not_evidence` is a sample about some other company, or one whose source URL
 * does not parse — nothing to learn from and nothing to report. `unread` is a
 * real address at this very domain that no known convention explains, or that
 * several explain equally: evidence that was gathered, paid for with a web
 * search, and then could not be used. Those two were the same `continue`
 * before, which is precisely why nobody could tell how much evidence was being
 * thrown away.
 */
type SampleReading =
  | { kind: "not_evidence" }
  | { kind: "unread" }
  | {
      kind: "named";
      pattern: EmailPattern;
      normalizedEmail: string;
      /**
       * Which spelling this sample used, when its own name could tell them
       * apart. Undefined for a name with nothing inside it, which agrees with
       * both and therefore proves neither.
       */
      rendering?: NameRendering;
    };

function readSample(sample: PublicEmailSample, domain: string): SampleReading {
  let normalizedSample: string;
  try {
    normalizedSample = normalizeEmail(sample.email);
    if (
      normalizedSample.slice(normalizedSample.lastIndexOf("@") + 1) !== domain
    ) {
      return { kind: "not_evidence" };
    }
    new URL(sample.sourceUrl);
  } catch {
    return { kind: "not_evidence" };
  }
  const matchingPatterns: EmailPattern[] = [];
  // Which spelling matched, when the name could tell them apart at all.
  let rendering: NameRendering | undefined;
  const distinguishes = hasDistinctCollapsedForm(
    sample.firstName,
    sample.lastName,
  );
  for (const pattern of EMAIL_PATTERNS) {
    // Both spellings, because a sample proves a *convention* and the company's
    // choice of separator is a second question. Judging only the hyphenated
    // form would discard every collapsed sample at a company that collapses —
    // exactly the silence this whole area was fixed for, pointed the other way.
    let matched = false;
    for (const candidateRendering of ["hyphenated", "collapsed"] as const) {
      let candidate: string;
      try {
        candidate = generateCandidateAddress({
          firstName: sample.firstName,
          lastName: sample.lastName,
          domain,
          pattern,
          rendering: candidateRendering,
        });
      } catch {
        continue;
      }
      if (candidate !== normalizedSample) continue;
      matched = true;
      // Only a name with a separator in it can settle which spelling this
      // company uses; anything else matches both and proves neither.
      if (distinguishes) rendering ??= candidateRendering;
    }
    if (matched) matchingPatterns.push(pattern);
  }
  // Initial-only names cannot distinguish `first.last` from `f.last`
  // (and equivalent collisions). Such samples prove an address, not a
  // convention, so they must not amplify either pattern's confidence.
  const pattern =
    matchingPatterns.length === 1 ? matchingPatterns[0] : undefined;
  if (!pattern) return { kind: "unread" };
  return {
    kind: "named",
    pattern,
    normalizedEmail: normalizedSample,
    ...(rendering ? { rendering } : {}),
  };
}

/**
 * The samples that were evidence about this company and still taught nothing.
 *
 * Reported rather than counted inside `inferEmailPatterns` so the caller can
 * record the addresses themselves: "seven samples unread" says a convention is
 * missing, and `fwsmith@`, `djbronczek@`, `dlcunningham@` says which one.
 */
export function unusedPublicSamples(
  samples: PublicEmailSample[],
  companyDomain: string,
): PublicEmailSample[] {
  const domain = normalizeDomain(companyDomain);
  return samples.filter(
    (sample) => readSample(sample, domain).kind === "unread",
  );
}

export type InferredEmailPattern = {
  pattern: EmailPattern;
  sampleCount: number;
  sourceUrls: string[];
  /**
   * How this company was observed to write a compound name, when one of its own
   * samples had a compound name to observe. Absent means the corpus is silent
   * and the ladder decides.
   */
  preferredRendering?: NameRendering;
};

export function inferEmailPatterns(
  samples: PublicEmailSample[],
  companyDomain: string,
): InferredEmailPattern[] {
  const domain = normalizeDomain(companyDomain);
  const matches = new Map<
    EmailPattern,
    {
      emails: Set<string>;
      sourceUrls: Set<string>;
      rendering?: NameRendering;
    }
  >();
  for (const sample of samples) {
    const reading = readSample(sample, domain);
    if (reading.kind !== "named") continue;
    const evidence = matches.get(reading.pattern) ?? {
      emails: new Set<string>(),
      sourceUrls: new Set<string>(),
    };
    evidence.emails.add(reading.normalizedEmail);
    evidence.sourceUrls.add(sample.sourceUrl);
    // First compound-named sample wins. A second one disagreeing would mean the
    // company runs both spellings, and the ladder is what settles that.
    evidence.rendering ??= reading.rendering;
    matches.set(reading.pattern, evidence);
  }
  return [...matches.entries()]
    .map(([pattern, evidence]) => ({
      pattern,
      sampleCount: evidence.emails.size,
      sourceUrls: [...evidence.sourceUrls],
      ...(evidence.rendering ? { preferredRendering: evidence.rendering } : {}),
    }))
    .sort(
      (left, right) =>
        right.sampleCount - left.sampleCount ||
        EMAIL_PATTERNS.indexOf(left.pattern) -
          EMAIL_PATTERNS.indexOf(right.pattern),
    );
}

export function scoreEmailCandidate(input: {
  sampleCount: number;
  mxValid: boolean;
}): number {
  if (input.sampleCount <= 0) return 0;
  if (!input.mxValid) return 0.4;
  if (input.sampleCount === 1) return 0.75;
  if (input.sampleCount === 2) return 0.9;
  return 0.97;
}
