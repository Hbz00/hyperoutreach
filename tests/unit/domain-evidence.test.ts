import { describe, expect, it } from "vitest";

import {
  addressResolutionBlocker,
  domainEvidenceBlocker,
  hasDomainEvidence,
} from "@/modules/email-resolution/domain-evidence";

describe("hasDomainEvidence", () => {
  it("is false when nothing was ever recorded", () => {
    expect(hasDomainEvidence([])).toBe(false);
  });

  it("is false when a source carries no supports at all", () => {
    expect(hasDomainEvidence([{ supports: [] }])).toBe(false);
  });

  // A company can be researched and still not have its domain tied: research
  // records whatever the model declared, and that is not always the domain.
  it("is false when sources support other claims only", () => {
    expect(
      hasDomainEvidence([{ supports: ["headcount"] }, { supports: ["news"] }]),
    ).toBe(false);
  });

  it("is true when any one source ties the domain", () => {
    expect(
      hasDomainEvidence([
        { supports: ["headcount"] },
        { supports: ["news", "domain"] },
      ]),
    ).toBe(true);
  });
});

describe("domainEvidenceBlocker", () => {
  it("blocks a company with no domain at all", () => {
    expect(
      domainEvidenceBlocker({ domain: null, hasDomainEvidence: true }),
    ).toMatch(/No evidence ties a domain/);
  });

  it("blocks a company whose domain nothing evidences", () => {
    expect(
      domainEvidenceBlocker({
        domain: "example.com",
        hasDomainEvidence: false,
      }),
    ).toMatch(/No evidence ties a domain/);
  });

  it("lets an evidenced domain through", () => {
    expect(
      domainEvidenceBlocker({ domain: "example.com", hasDomainEvidence: true }),
    ).toBeNull();
  });
});

describe("addressResolutionBlocker", () => {
  // Asked before the domain question because it is the more useful answer: a
  // company nobody has discovered contacts for has nobody to resolve for,
  // whatever its evidence says.
  it("asks for contacts first, even when the domain is evidenced", () => {
    expect(
      addressResolutionBlocker({
        contactCount: 0,
        domain: "example.com",
        hasDomainEvidence: true,
      }),
    ).toMatch(/Discover contacts first/);
  });

  it("falls through to the domain question once contacts exist", () => {
    expect(
      addressResolutionBlocker({
        contactCount: 3,
        domain: "example.com",
        hasDomainEvidence: false,
      }),
    ).toMatch(/No evidence ties a domain/);
  });

  it("blocks nothing when there are contacts and an evidenced domain", () => {
    expect(
      addressResolutionBlocker({
        contactCount: 3,
        domain: "example.com",
        hasDomainEvidence: true,
      }),
    ).toBeNull();
  });
});
