import { describe, expect, it } from "vitest";

import {
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePersonName,
} from "@/modules/prospects/normalization";

describe("prospect normalization", () => {
  it("normalizes company names for deterministic deduplication", () => {
    expect(normalizeCompanyName("  Société  ACME, S.A.S.  ")).toBe(
      "societe acme sas",
    );
  });

  it("normalizes international person names without discarding letters", () => {
    expect(normalizePersonName("  Chloé   D’Angelo  ")).toBe("chloe d angelo");
  });

  it("extracts and normalizes a registrable-looking host", () => {
    expect(normalizeDomain(" HTTPS://WWW.Example.COM/about/?ref=one ")).toBe(
      "example.com",
    );
  });

  it("rejects malformed or credential-bearing domains", () => {
    expect(() => normalizeDomain("not a domain")).toThrow("Invalid domain");
    expect(() => normalizeDomain("https://user:pass@example.com")).toThrow(
      "Invalid domain",
    );
  });

  it("normalizes valid email addresses and rejects malformed values", () => {
    expect(normalizeEmail(" Alice.Doe@Example.COM ")).toBe(
      "alice.doe@example.com",
    );
    expect(() => normalizeEmail("alice.example.com")).toThrow("Invalid email");
  });
});
