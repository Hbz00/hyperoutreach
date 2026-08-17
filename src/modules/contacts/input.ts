import { z } from "zod";

import { normalizePersonName } from "@/modules/prospects/normalization";

/**
 * LinkedIn serves the same profile from more than one host of its own, and the
 * one it serves depends on where the reader is: a French profile arrives as
 * `fr.linkedin.com`, a German one as `de.linkedin.com`, a phone as
 * `m.linkedin.com`. Accepting only `linkedin.com` and `www.linkedin.com`
 * therefore refused every profile a web-searching agent found in France — ten
 * real contacts at a time, since one refusal fails the whole discovery batch.
 *
 * One label under `linkedin.com` is LinkedIn's own by DNS, so a single leading
 * label is accepted and nothing deeper is: `a.b.linkedin.com` and the
 * lookalike `linkedin.com.example.org` both stay refused. Every accepted form
 * still canonicalises to the one `www` URL below, which is what keeps the same
 * person found through two hosts a single deduplicated contact rather than two.
 */
function isLinkedInHost(hostname: string): boolean {
  if (hostname === "linkedin.com") return true;
  const suffix = ".linkedin.com";
  if (!hostname.endsWith(suffix)) return false;
  const prefix = hostname.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes(".");
}

/**
 * The same canonicalisation, for callers that must compare a stored contact
 * identity against a raw URL an agent just produced.
 *
 * Comparing them with a generic URL normaliser does not work: that one only
 * lower-cases the host, so the stored `www.linkedin.com/in/victor-guyon` and the
 * evidence `fr.linkedin.com/in/Victor-Guyon` read as two different pages and an
 * employment proof that is plainly present reads as absent. Returns `null`
 * rather than throwing, because a caller comparing evidence is asking a
 * question, not validating an input.
 */
export function canonicalLinkedInUrl(value: string): string | null {
  try {
    return normalizeLinkedInUrl(value);
  } catch {
    return null;
  }
}

function normalizeLinkedInUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid LinkedIn URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const profileSlug = pathSegments[1]?.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !isLinkedInHost(hostname) ||
    pathSegments[0]?.toLowerCase() !== "in" ||
    !profileSlug ||
    !/^[a-z0-9_%.-]+$/.test(profileSlug) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error("Invalid LinkedIn URL");
  }
  return `https://www.linkedin.com/in/${profileSlug}`;
}

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
  z.string().nullable(),
);

const contactInputSchema = z
  .object({
    accountId: z.uuid(),
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    jobTitle: optionalTrimmedString,
    linkedinUrl: optionalTrimmedString,
    professionalRelevance: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .transform((input, context) => {
    const fullName = `${input.firstName} ${input.lastName}`;
    try {
      return {
        ...input,
        fullName,
        normalizedFullName: normalizePersonName(fullName),
        linkedinUrl: input.linkedinUrl
          ? normalizeLinkedInUrl(input.linkedinUrl)
          : null,
      };
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid contact",
      });
      return z.NEVER;
    }
  });

export type ContactInput = z.infer<typeof contactInputSchema>;

export function parseContactInput(value: unknown): ContactInput {
  return contactInputSchema.parse(value);
}

export function resolveContactIdentity(
  input: ContactInput,
):
  | { kind: "linkedin"; value: string }
  | { kind: "account_name"; accountId: string; normalizedFullName: string } {
  return input.linkedinUrl
    ? { kind: "linkedin", value: input.linkedinUrl }
    : {
        kind: "account_name",
        accountId: input.accountId,
        normalizedFullName: input.normalizedFullName,
      };
}
