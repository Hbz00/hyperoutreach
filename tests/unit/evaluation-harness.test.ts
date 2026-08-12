import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateFixture,
  evaluationFixtureSchema,
  formatEvaluationReport,
  runEvaluationFile,
  type EvaluationFixture,
} from "@/modules/evaluation/harness";

const basePolicyInput = {
  campaignStatus: "active" as const,
  enrollmentState: "approved" as const,
  messageStatus: "approved" as const,
  recipientSuppressed: false,
  mailboxRequired: true,
  mailboxStatus: "available" as const,
  stepAlreadySent: false,
  expectedStepMatches: true,
  providerMatches: true,
  withinWorkingHours: true,
  mailboxMinimumDelaySatisfied: true,
  contactMinimumDelaySatisfied: true,
  recentContactCooldownSatisfied: true,
  professionalRelevanceRequired: true,
  professionallyRelevant: true,
};

function passingFixture(): EvaluationFixture {
  return {
    fixtureVersion: "v1",
    dataset: "unit-fixture",
    thresholds: {
      accountPrecision: 0.5,
      contactPrecision: 0.5,
      evidenceSupportRate: 0.5,
      emailAccuracy: 0.5,
      emailConfidenceAccuracy: 0.5,
      emailReasonAccuracy: 0.5,
      personalizationAcceptanceRate: 0.5,
      replyOutcomeAccuracy: 0.5,
      policyOutcomeAccuracy: 0.5,
      duplicatePreventionAccuracy: 0.5,
    },
    fixtureProvenance: {
      method: "synthetic_contract",
      description: "Unit-test contract cases",
      independentlyVerified: false,
    },
    prospects: Array.from({ length: 100 }, (_, index) => ({
      id: `prospect-${String(index + 1).padStart(3, "0")}`,
      capture: {
        provider: "synthetic",
        model: "contract-v1",
        promptVersion: "prompt-v1",
        schemaVersion: "schema-v1",
      },
      expected: {
        accountKey: `account-${index}.example`,
        personKey: `https://people.example/person-${index}`,
        companyAccountKey: `account-${index}.example`,
        jobTitle: "VP Sales",
        requiredEvidenceSupports: ["employment"],
        acceptedEvidence: [
          {
            support: "employment",
            sourceUrl: `https://source-${index + 1}.example/fact`,
          },
        ],
      },
      observed: {
        accountKey:
          index % 2 === 0
            ? `account-${index}.example`
            : `wrong-${index}.example`,
        personKey:
          index % 2 === 0
            ? `https://people.example/person-${index}`
            : `https://people.example/wrong-${index}`,
        companyAccountKey: `account-${index}.example`,
        jobTitle: "VP Sales",
        evidence:
          index % 2 === 0
            ? [
                {
                  url: `https://source-${index + 1}.example/fact`,
                  supports: ["employment"],
                },
              ]
            : [],
        personalization: {
          value: `Synthetic personalization ${index + 1}`,
          sourceUrls: [`https://source-${index + 1}.example/fact`],
          accepted: index % 2 === 0,
        },
      },
    })),
    emails: [
      {
        id: "alice-acme",
        firstName: "Alice",
        lastName: "Martin",
        domain: "acme.example",
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: "marie.dupont@acme.example",
            sourceUrl: "https://acme.example/team/marie",
          },
          {
            firstName: "John",
            lastName: "Smith",
            email: "john.smith@acme.example",
            sourceUrl: "https://acme.example/team/john",
          },
        ],
        mxValid: true,
        confidenceThreshold: 0.85,
        expectedEmail: "alice.martin@acme.example",
        expectedConfidence: { min: 0.9, max: 0.9 },
        expectedReason: null,
      },
      {
        id: "bob-no-evidence",
        firstName: "Bob",
        lastName: "Smith",
        domain: "globex.example",
        publicSamples: [],
        mxValid: true,
        confidenceThreshold: 0.85,
        expectedEmail: "bob.smith@globex.example",
        expectedConfidence: { min: 0.75, max: 1 },
        expectedReason: null,
      },
    ],
    replies: [
      {
        id: "unsubscribe",
        input: {
          subject: "Re: hello",
          body: "Please unsubscribe me.",
          sender: "alice@acme.example",
        },
        bounceKind: null,
        holdNonTerminal: true,
        expectedCategory: "unsubscribe",
        expectedTerminal: true,
        expectedSuppression: true,
      },
      {
        id: "positive-mismatch",
        input: {
          subject: "Re: hello",
          body: "Interested, let's schedule.",
          sender: "bob@globex.example",
        },
        bounceKind: null,
        holdNonTerminal: true,
        expectedCategory: "negative",
        expectedTerminal: true,
        expectedSuppression: false,
      },
    ],
    policies: [
      { id: "eligible", input: basePolicyInput, expected: "ALLOW" },
      {
        id: "suppressed",
        input: { ...basePolicyInput, recipientSuppressed: true },
        expected: "RECIPIENT_SUPPRESSED",
      },
    ],
    duplicates: [
      {
        id: "domains",
        kind: "company_domain",
        values: [
          "Acme.example",
          "https://www.acme.example/about",
          "globex.example",
        ],
        expectedUniqueCount: 2,
      },
      {
        id: "emails",
        kind: "email",
        values: [
          " Alice@Acme.example ",
          "alice@acme.example",
          "bob@acme.example",
        ],
        expectedUniqueCount: 2,
      },
    ],
  };
}

describe("deterministic evaluation harness", () => {
  it("reports every required metric and counts prevented duplicates", async () => {
    const report = await evaluateFixture(passingFixture());

    expect(report.metrics).toMatchObject({
      accountPrecision: { value: 0.5, passed: true },
      contactPrecision: { value: 0.5, passed: true },
      evidenceSupportRate: { value: 0.5, passed: true },
      emailAccuracy: { value: 0.5, passed: true },
      emailConfidenceAccuracy: { value: 0.5, passed: true },
      emailReasonAccuracy: { value: 0.5, passed: true },
      personalizationAcceptanceRate: { value: 0.5, passed: true },
      replyOutcomeAccuracy: { value: 0.5, passed: true },
      policyOutcomeAccuracy: { value: 1, passed: true },
      duplicatePreventionAccuracy: { value: 1, passed: true },
    });
    expect(report.duplicatesPrevented).toBe(2);
    expect(report.prospectCases).toBe(100);
    expect(report.passed).toBe(true);
  });

  it("fails deterministically when a declared threshold regresses", async () => {
    const fixture = passingFixture();
    fixture.thresholds.emailAccuracy = 0.75;

    const report = await evaluateFixture(fixture);

    expect(report.passed).toBe(false);
    expect(report.failures).toContain(
      "emailAccuracy: 50.00% is below threshold 75.00%",
    );
    expect(formatEvaluationReport(report)).toContain("RESULT  FAIL");
  });

  it("fails when a captured prediction regresses without changing thresholds", async () => {
    const fixture = passingFixture();
    fixture.prospects[0]!.observed.accountKey = "regressed.example";

    const report = await evaluateFixture(fixture);

    expect(report.metrics.accountPrecision).toMatchObject({
      numerator: 49,
      denominator: 100,
      passed: false,
    });
    expect(report.failures[0]).toContain("accountPrecision");
  });

  it("requires evidence to declare the fact support rather than merely contain a URL", async () => {
    const fixture = passingFixture();
    fixture.prospects[0]!.observed.evidence[0]!.supports = ["identity"];

    const report = await evaluateFixture(fixture);

    expect(report.metrics.evidenceSupportRate).toMatchObject({
      numerator: 49,
      denominator: 100,
      passed: false,
    });
  });

  it("rejects model-declared support from a source URL not accepted by human ground truth", async () => {
    const fixture = passingFixture();
    fixture.prospects[0]!.observed.evidence[0]!.url =
      "https://fabricated.example/not-supporting-this-fact";

    const report = await evaluateFixture(fixture);

    expect(report.metrics.evidenceSupportRate).toMatchObject({
      numerator: 49,
      denominator: 100,
      passed: false,
    });
  });

  it("rejects malformed or unversioned fixture data", () => {
    const fixture = passingFixture();
    expect(
      evaluationFixtureSchema.safeParse({
        ...fixture,
        fixtureVersion: "latest",
      }).success,
    ).toBe(false);
    expect(
      evaluationFixtureSchema.safeParse({ ...fixture, thresholds: {} }).success,
    ).toBe(false);
    expect(
      evaluationFixtureSchema.safeParse({
        ...fixture,
        prospects: fixture.prospects.slice(0, 99),
      }).success,
    ).toBe(false);
  });

  it("loads a fixture file and exposes a failing exit contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperoutreach-eval-"));
    const fixture = passingFixture();
    fixture.thresholds.emailAccuracy = 0.75;
    const fixturePath = join(directory, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const execution = await runEvaluationFile(fixturePath);

    expect(execution.exitCode).toBe(1);
    expect(execution.output).toContain("emailAccuracy");
    expect(execution.report.fixtureVersion).toBe("v1");
  });

  it("scores frozen structured reply output including hard-bounce outcomes", async () => {
    const fixture = passingFixture();
    fixture.replies = [
      {
        id: "hard-bounce",
        input: {
          subject: "Delivery failed",
          body: "550 recipient does not exist",
          sender: "postmaster@acme.example",
        },
        observedCategory: "bounce",
        bounceKind: "hard",
        holdNonTerminal: true,
        expectedCategory: "bounce",
        expectedTerminal: true,
        expectedSuppression: true,
        expectedState: "bounced",
        expectedStopReason: "hard_bounce",
      },
    ];

    const report = await evaluateFixture(fixture);

    expect(report.metrics.replyOutcomeAccuracy.value).toBe(1);
  });
});
