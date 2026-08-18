import { describe, expect, it } from "vitest";

import {
  describeEnrollmentSelection,
  parseEnrollmentFilters,
  partitionCandidates,
  type EnrollmentCandidate,
  type EnrollmentSelectionOutcome,
} from "@/modules/campaigns/enrollment-selection";

function candidate(
  overrides: Partial<EnrollmentCandidate> = {},
): EnrollmentCandidate {
  return {
    contactId: crypto.randomUUID(),
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
    jobTitle: "Head of Computation",
    email: "ada@example.com",
    confidence: 0.9,
    ineligibility: null,
    ...overrides,
  };
}

describe("parseEnrollmentFilters", () => {
  it("keeps trimmed text filters and drops empty ones", () => {
    expect(
      parseEnrollmentFilters({ company: "  MOUSSET  ", role: "   " }),
    ).toEqual({ company: "MOUSSET" });
  });

  // A bad number in a URL must not be a dead end: the filter is dropped and
  // the page still answers.
  it("drops a confidence that is not a number", () => {
    expect(parseEnrollmentFilters({ minConfidence: "not-a-number" })).toEqual(
      {},
    );
  });

  it("drops a confidence outside zero and one", () => {
    expect(parseEnrollmentFilters({ minConfidence: "92" })).toEqual({});
    expect(parseEnrollmentFilters({ minConfidence: "-0.5" })).toEqual({});
  });

  it("keeps a confidence inside the range, including its bounds", () => {
    expect(parseEnrollmentFilters({ minConfidence: "0" })).toEqual({
      minConfidence: 0,
    });
    expect(parseEnrollmentFilters({ minConfidence: "0.85" })).toEqual({
      minConfidence: 0.85,
    });
    expect(parseEnrollmentFilters({ minConfidence: "1" })).toEqual({
      minConfidence: 1,
    });
  });

  it("reads nothing from an empty query string", () => {
    expect(parseEnrollmentFilters({})).toEqual({});
  });

  // `?company=a&company=b` is a legal URL and Next hands the value over as an
  // array. This used to throw before the page rendered at all, which turned a
  // duplicated parameter into a server error with no error boundary to catch
  // it.
  it("survives a repeated query parameter and takes the first value", () => {
    expect(
      parseEnrollmentFilters({
        company: ["MOUSSET", "Radiance"],
        role: ["logistique"],
        minConfidence: ["0.8", "0.2"],
      }),
    ).toEqual({ company: "MOUSSET", role: "logistique", minConfidence: 0.8 });
  });

  it("survives a repeated parameter whose first value is empty", () => {
    expect(parseEnrollmentFilters({ company: [] })).toEqual({});
  });
});

describe("partitionCandidates", () => {
  it("separates the eligible rows and counts the rest by reason", () => {
    const eligibleRow = candidate();
    const result = partitionCandidates([
      eligibleRow,
      candidate({ ineligibility: "already_enrolled" }),
      candidate({ ineligibility: "already_enrolled" }),
      candidate({ ineligibility: "suppressed" }),
    ]);

    expect(result.eligible).toEqual([eligibleRow]);
    expect(result.excluded).toEqual({
      already_enrolled: 2,
      suppressed: 1,
    });
  });

  // Every reason is present at zero rather than absent, so the screen can read
  // a count without asking whether the key exists.
  it("reports every reason at zero when nothing is excluded", () => {
    expect(partitionCandidates([]).excluded).toEqual({
      already_enrolled: 0,
      suppressed: 0,
    });
  });
});

describe("describeEnrollmentSelection", () => {
  function outcome(overrides: Partial<EnrollmentSelectionOutcome> = {}) {
    return {
      enrolled: 0,
      alreadyEnrolled: 0,
      ignored: 0,
      truncated: 0,
      failed: 0,
      ...overrides,
    };
  }

  it("names only what happened", () => {
    expect(describeEnrollmentSelection(outcome({ enrolled: 12 }))).toBe(
      "12 prospects enrolled — their first messages are queued",
    );
  });

  it("names one prospect in the singular", () => {
    expect(describeEnrollmentSelection(outcome({ enrolled: 1 }))).toBe(
      "1 prospect enrolled — their first message is queued",
    );
  });

  it("adds every non-zero outcome", () => {
    expect(
      describeEnrollmentSelection({
        enrolled: 3,
        alreadyEnrolled: 1,
        ignored: 2,
        truncated: 4,
        failed: 5,
      }),
    ).toBe(
      "3 prospects enrolled — their first messages are queued · 1 already enrolled · 2 no longer eligible · 4 beyond this request's ceiling of 500, run it again · 5 could not be enrolled",
    );
  });

  it("says plainly when nothing was enrolled", () => {
    expect(describeEnrollmentSelection(outcome({ ignored: 3 }))).toBe(
      "Nothing enrolled · 3 no longer eligible",
    );
  });
});
