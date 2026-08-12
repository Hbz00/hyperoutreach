import { describe, expect, it } from "vitest";

import {
  parseAccountInput,
  resolveAccountIdentity,
} from "@/modules/accounts/input";
import {
  parseContactInput,
  resolveContactIdentity,
} from "@/modules/contacts/input";

describe("prospect input and identity decisions", () => {
  it("uses a normalized domain as the strong account identity", () => {
    const input = parseAccountInput({ name: " Acme ", domain: "WWW.Acme.COM" });
    expect(input).toEqual({
      name: "Acme",
      normalizedName: "acme",
      domain: "acme.com",
      website: null,
    });
    expect(resolveAccountIdentity(input)).toEqual({
      kind: "domain",
      value: "acme.com",
    });
  });

  it("falls back to a normalized name only when the account has no domain", () => {
    const input = parseAccountInput({ name: " Société Acme " });
    expect(resolveAccountIdentity(input)).toEqual({
      kind: "normalized_name",
      value: "societe acme",
    });
  });

  it("rejects invalid account input with Zod", () => {
    expect(() =>
      parseAccountInput({ name: " ", domain: "not a domain" }),
    ).toThrow();
  });

  it("rejects non-HTTP account websites", () => {
    expect(() =>
      parseAccountInput({
        name: "Unsafe Website",
        website: "javascript:alert(1)",
      }),
    ).toThrow();
  });

  it("uses a normalized LinkedIn URL as global contact identity", () => {
    const input = parseContactInput({
      accountId: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
      firstName: " Alice ",
      lastName: " Martin ",
      linkedinUrl: "https://www.linkedin.com/in/Alice-Martin/?trk=public",
    });
    expect(resolveContactIdentity(input)).toEqual({
      kind: "linkedin",
      value: "https://www.linkedin.com/in/alice-martin",
    });
  });

  it("canonicalizes LinkedIn profiles to exactly the public profile slug", () => {
    const input = parseContactInput({
      accountId: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
      firstName: "Alice",
      lastName: "Martin",
      linkedinUrl:
        "https://www.linkedin.com/in/Alice-Martin/details/recent-activity/?trk=public",
    });
    expect(input.linkedinUrl).toBe("https://www.linkedin.com/in/alice-martin");
  });

  it("uses account/name fallback only without LinkedIn", () => {
    const input = parseContactInput({
      accountId: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
      firstName: " Chloé ",
      lastName: " D’Angelo ",
    });
    expect(resolveContactIdentity(input)).toEqual({
      kind: "account_name",
      accountId: input.accountId,
      normalizedFullName: "chloe d angelo",
    });
  });

  it("rejects non-LinkedIn profile URLs", () => {
    expect(() =>
      parseContactInput({
        accountId: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
        firstName: "Alice",
        lastName: "Martin",
        linkedinUrl: "https://example.com/alice",
      }),
    ).toThrow();
    expect(() =>
      parseContactInput({
        accountId: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
        firstName: "Alice",
        lastName: "Martin",
        linkedinUrl: "https://linkedin.com/company/acme",
      }),
    ).toThrow();
  });
});
