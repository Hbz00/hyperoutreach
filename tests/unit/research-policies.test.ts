import { describe, expect, it } from "vitest";

import { decideAccountMerge } from "@/modules/research/account-merge";
import { shouldReuseResearch } from "@/modules/research/freshness";

describe("account discovery merge policy", () => {
  it("uses an exact normalized domain as the strongest identity", () => {
    expect(
      decideAccountMerge({
        incomingDomain: "acme.example",
        strongDomainAccountId: "strong",
        domainlessNameAccountId: "fallback",
        sameNameDomainAccountId: "strong",
      }),
    ).toEqual({ action: "use_existing", accountId: "strong" });
  });

  it("enriches an unambiguous domainless fallback with a newly evidenced domain", () => {
    expect(
      decideAccountMerge({
        incomingDomain: "acme.example",
        strongDomainAccountId: null,
        domainlessNameAccountId: "fallback",
        sameNameDomainAccountId: null,
      }),
    ).toEqual({ action: "enrich_fallback", accountId: "fallback" });
  });

  it("does not merge same-name companies that have different strong domains", () => {
    expect(
      decideAccountMerge({
        incomingDomain: "acme.fr",
        strongDomainAccountId: null,
        domainlessNameAccountId: null,
        sameNameDomainAccountId: "different-domain",
      }),
    ).toEqual({ action: "create" });
  });

  it("uses name fallback only for a domainless incoming company", () => {
    expect(
      decideAccountMerge({
        incomingDomain: null,
        strongDomainAccountId: null,
        domainlessNameAccountId: "fallback",
        sameNameDomainAccountId: "strong",
      }),
    ).toEqual({ action: "use_existing", accountId: "fallback" });
  });

  it("uses an existing same-name domain account for a later domainless candidate", () => {
    expect(
      decideAccountMerge({
        incomingDomain: null,
        strongDomainAccountId: null,
        domainlessNameAccountId: null,
        sameNameDomainAccountId: "strong",
      }),
    ).toEqual({ action: "use_existing", accountId: "strong" });
  });
});

describe("research freshness policy", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  it("reuses a complete snapshot within the configured TTL", () => {
    expect(
      shouldReuseResearch({
        snapshot: { summary: "stored" },
        researchedAt: new Date("2026-08-12T11:00:00.000Z"),
        now,
        ttlMs: 2 * 60 * 60 * 1_000,
        force: false,
      }),
    ).toBe(true);
  });

  it.each([
    ["forced", true, new Date("2026-08-12T11:00:00.000Z"), { stored: true }],
    ["stale", false, new Date("2026-08-10T00:00:00.000Z"), { stored: true }],
    ["missing snapshot", false, new Date("2026-08-12T11:00:00.000Z"), null],
    ["missing timestamp", false, null, { stored: true }],
  ])("does not reuse %s research", (_label, force, researchedAt, snapshot) => {
    expect(
      shouldReuseResearch({
        snapshot,
        researchedAt,
        now,
        ttlMs: 3_600_000,
        force,
      }),
    ).toBe(false);
  });
});
