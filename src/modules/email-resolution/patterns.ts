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

export function normalizeEmailNamePart(value: string): string {
  const replaced = [...value.toLocaleLowerCase("en-US")]
    .map((character) => transliterations[character] ?? character)
    .join("");
  const normalized = replaced
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^a-z0-9]+/g, "");
  if (!normalized) throw new Error("Name cannot produce an email local part");
  return normalized;
}

function localPartForPattern(
  firstName: string,
  lastName: string,
  pattern: EmailPattern,
): string {
  const first = normalizeEmailNamePart(firstName);
  const last = normalizeEmailNamePart(lastName);
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
}): string {
  return normalizeEmail(
    `${localPartForPattern(input.firstName, input.lastName, input.pattern)}@${normalizeDomain(input.domain)}`,
  );
}

export type PublicEmailSample = {
  firstName: string;
  lastName: string;
  email: string;
  sourceUrl: string;
};

export function inferEmailPatterns(
  samples: PublicEmailSample[],
  companyDomain: string,
): Array<{
  pattern: EmailPattern;
  sampleCount: number;
  sourceUrls: string[];
}> {
  const domain = normalizeDomain(companyDomain);
  const matches = new Map<
    EmailPattern,
    { emails: Set<string>; sourceUrls: Set<string> }
  >();
  for (const sample of samples) {
    let normalizedSample: string;
    try {
      normalizedSample = normalizeEmail(sample.email);
      if (
        normalizedSample.slice(normalizedSample.lastIndexOf("@") + 1) !== domain
      ) {
        continue;
      }
      new URL(sample.sourceUrl);
    } catch {
      continue;
    }
    const matchingPatterns: EmailPattern[] = [];
    for (const pattern of EMAIL_PATTERNS) {
      let candidate: string;
      try {
        candidate = generateCandidateAddress({
          firstName: sample.firstName,
          lastName: sample.lastName,
          domain,
          pattern,
        });
      } catch {
        continue;
      }
      if (candidate === normalizedSample) matchingPatterns.push(pattern);
    }
    // Initial-only names cannot distinguish `first.last` from `f.last`
    // (and equivalent collisions). Such samples prove an address, not a
    // convention, so they must not amplify either pattern's confidence.
    if (matchingPatterns.length !== 1) continue;
    const pattern = matchingPatterns[0]!;
    const evidence = matches.get(pattern) ?? {
      emails: new Set<string>(),
      sourceUrls: new Set<string>(),
    };
    evidence.emails.add(normalizedSample);
    evidence.sourceUrls.add(sample.sourceUrl);
    matches.set(pattern, evidence);
  }
  return [...matches.entries()]
    .map(([pattern, evidence]) => ({
      pattern,
      sampleCount: evidence.emails.size,
      sourceUrls: [...evidence.sourceUrls],
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
