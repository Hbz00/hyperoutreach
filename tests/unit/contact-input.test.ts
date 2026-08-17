import { describe, expect, it } from "vitest";

import {
  canonicalLinkedInUrl,
  parseContactInput,
} from "@/modules/contacts/input";

const ACCOUNT_ID = "7b082ffe-0ed4-43cc-8744-1889d552d29b";

function linkedinUrlOf(linkedinUrl: string | null): string | null {
  return parseContactInput({
    accountId: ACCOUNT_ID,
    firstName: "Victor",
    lastName: "Guyon",
    jobTitle: "Directeur Régional Nord Est",
    linkedinUrl,
  }).linkedinUrl;
}

const CANONICAL = "https://www.linkedin.com/in/victor-guyon-281a17194";

describe("contact LinkedIn identity", () => {
  /**
   * The regression this file exists for: a web-searching agent looking at the
   * French web gets `fr.linkedin.com` for every profile, and refusing that host
   * refused every French contact — and with it the whole discovery batch.
   */
  it.each([
    "https://fr.linkedin.com/in/victor-guyon-281a17194",
    "https://de.linkedin.com/in/victor-guyon-281a17194",
    "https://uk.linkedin.com/in/victor-guyon-281a17194",
    "https://m.linkedin.com/in/victor-guyon-281a17194",
    "https://www.linkedin.com/in/victor-guyon-281a17194",
    "https://linkedin.com/in/victor-guyon-281a17194",
  ])("accepts %s and canonicalizes it", (url) => {
    expect(linkedinUrlOf(url)).toBe(CANONICAL);
  });

  it("collapses every accepted host to one identity, so one person is one contact", () => {
    const identities = new Set(
      [
        "https://fr.linkedin.com/in/victor-guyon-281a17194",
        "https://www.linkedin.com/in/victor-guyon-281a17194",
        "https://linkedin.com/in/victor-guyon-281a17194",
        "https://FR.LinkedIn.com/IN/Victor-Guyon-281a17194",
      ].map((url) => linkedinUrlOf(url)),
    );
    expect([...identities]).toEqual([CANONICAL]);
  });

  it("keeps a percent-encoded profile slug, lowercased", () => {
    expect(
      linkedinUrlOf("https://fr.linkedin.com/in/vigneron-s%C3%A9bastien"),
    ).toBe("https://www.linkedin.com/in/vigneron-s%c3%a9bastien");
  });

  /**
   * One label under `linkedin.com` is LinkedIn's own by DNS. Two are not, and a
   * host that merely starts with the string is somebody else's entirely.
   */
  it.each([
    "https://a.b.linkedin.com/in/victor-guyon-281a17194",
    "https://linkedin.com.example.org/in/victor-guyon-281a17194",
    "https://notlinkedin.com/in/victor-guyon-281a17194",
    "http://fr.linkedin.com/in/victor-guyon-281a17194",
    "https://fr.linkedin.com/company/groupe-mousset",
    "https://fr.linkedin.com/in/",
  ])("refuses %s", (url) => {
    // Named, not bare: a bare `.toThrow()` is satisfied by any Zod complaint,
    // including one about a field this case is not testing.
    expect(() => linkedinUrlOf(url)).toThrow(/Invalid LinkedIn URL/);
  });

  /**
   * The same rule, asked as a question rather than as validation. Evidence
   * comparison calls this on URLs an agent produced, where an unusable one is
   * an answer — "not this profile" — and not an error to raise.
   */
  it("answers rather than throws when asked to canonicalize", () => {
    expect(
      canonicalLinkedInUrl("https://fr.linkedin.com/in/victor-guyon"),
    ).toBe("https://www.linkedin.com/in/victor-guyon");
    expect(
      canonicalLinkedInUrl("https://example.org/in/victor-guyon"),
    ).toBeNull();
    expect(canonicalLinkedInUrl("not a url at all")).toBeNull();
    expect(canonicalLinkedInUrl("")).toBeNull();
  });

  it("leaves a contact without a LinkedIn profile identifiable by name", () => {
    const parsed = parseContactInput({
      accountId: ACCOUNT_ID,
      firstName: "Vittorio",
      lastName: "Battaglia",
      jobTitle: "Directeur Général",
      linkedinUrl: null,
    });
    expect(parsed.linkedinUrl).toBeNull();
    expect(parsed.normalizedFullName).toBe("vittorio battaglia");
  });
});
