import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLIC_EVIDENCE_TTL_MS,
  shouldReusePublicEmailEvidence,
} from "@/modules/email-resolution/evidence-freshness";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const CURRENT = "public-email-evidence-prompt-v2";

function reuse(
  overrides: Partial<Parameters<typeof shouldReusePublicEmailEvidence>[0]> = {},
) {
  return shouldReusePublicEmailEvidence({
    sampleCount: 2,
    foundAt: new Date(NOW.getTime() - 60_000),
    recordedPromptVersion: CURRENT,
    currentPromptVersion: CURRENT,
    now: NOW,
    ttlMs: DEFAULT_PUBLIC_EVIDENCE_TTL_MS,
    force: false,
    ...overrides,
  });
}

/**
 * This rule decides whether a company is searched again or answered from the
 * record, so every clause of it is a decision about spending a web search from
 * a budget that runs out silently — and about how stale an answer a prospect
 * may be emailed on.
 */
describe("shouldReusePublicEmailEvidence", () => {
  it("reuses a recent, non-empty search made by the current prompt", () => {
    expect(reuse()).toBe(true);
  });

  it("reuses a record exactly at the age limit, and not one millisecond past it", () => {
    const atLimit = new Date(NOW.getTime() - DEFAULT_PUBLIC_EVIDENCE_TTL_MS);
    expect(reuse({ foundAt: atLimit })).toBe(true);
    expect(reuse({ foundAt: new Date(atLimit.getTime() - 1) })).toBe(false);
  });

  /**
   * The clause that matters most in practice. The same prompt on the same
   * domain returned zero, then one, then two addresses on three consecutive
   * real attempts, so caching "found nothing" would freeze the worst draw and
   * retire a company a second look would have resolved.
   */
  it("never reuses a search that found nothing", () => {
    expect(reuse({ sampleCount: 0 })).toBe(false);
  });

  it("never reuses a record made by a different prompt", () => {
    expect(
      reuse({ recordedPromptVersion: "public-email-evidence-prompt-v1" }),
    ).toBe(false);
    // A provider that reports no version — the deterministic fixture — matches
    // nothing and therefore searches.
    expect(reuse({ currentPromptVersion: "" })).toBe(false);
    expect(reuse({ recordedPromptVersion: null })).toBe(false);
  });

  it("searches when the operator asks for a fresh search", () => {
    expect(reuse({ force: true })).toBe(false);
  });

  it("refuses a record with no completion time", () => {
    expect(reuse({ foundAt: null })).toBe(false);
  });

  /**
   * A clock that moved backwards, or a record from the future, must not be read
   * as "brand new" — the age would be negative and pass any upper bound.
   */
  it("refuses a record dated in the future", () => {
    expect(reuse({ foundAt: new Date(NOW.getTime() + 1) })).toBe(false);
  });

  it("refuses a nonsensical lifetime rather than treating it as unlimited", () => {
    expect(reuse({ ttlMs: -1 })).toBe(false);
    expect(reuse({ ttlMs: Number.NaN })).toBe(false);
    expect(reuse({ ttlMs: Number.POSITIVE_INFINITY })).toBe(false);
    // Zero is a coherent setting — reuse nothing — not a nonsensical one.
    expect(reuse({ ttlMs: 0 })).toBe(false);
    expect(reuse({ ttlMs: 0, foundAt: NOW })).toBe(true);
  });

  it("keeps the documented lifetime at thirty days", () => {
    expect(DEFAULT_PUBLIC_EVIDENCE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1_000);
  });
});
