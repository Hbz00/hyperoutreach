import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  generateCandidateAddress,
  inferEmailPatterns,
  scoreEmailCandidate,
} from "@/modules/email-resolution/patterns";
import {
  SEND_POLICY_BLOCK_CODES,
  evaluateSendPolicy,
  type SendPolicyInput,
} from "@/modules/messages/send-policy";
import {
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePersonName,
} from "@/modules/prospects/normalization";
import {
  DeterministicReplyClassifier,
  REPLY_CATEGORIES,
} from "@/modules/replies/reply-classifier";
import { canonicalLinkedInUrl } from "@/modules/contacts/input";
import { mapReplyOutcome } from "@/modules/replies/reply-policy";

export const EVALUATION_METRIC_NAMES = [
  "accountPrecision",
  "contactPrecision",
  "evidenceSupportRate",
  "emailAccuracy",
  "emailConfidenceAccuracy",
  "emailReasonAccuracy",
  "personalizationAcceptanceRate",
  "replyOutcomeAccuracy",
  "policyOutcomeAccuracy",
  "duplicatePreventionAccuracy",
] as const;

export type EvaluationMetricName = (typeof EVALUATION_METRIC_NAMES)[number];

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});

const publicEmailSampleSchema = z
  .object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    email: z.string().trim().min(3),
    sourceUrl: httpUrlSchema,
  })
  .strict();

const sendPolicyInputSchema = z
  .object({
    campaignStatus: z.enum([
      "draft",
      "active",
      "paused",
      "completed",
      "archived",
    ]),
    enrollmentState: z.enum([
      "ready_for_review",
      "approved",
      "active",
      "waiting",
      "manual_review",
      "paused",
      "replied",
      "bounced",
      "opted_out",
      "completed",
      "stopped",
      "failed",
    ]),
    messageStatus: z.enum([
      "proposed",
      "approved",
      "draft_creating",
      "drafted",
      "sending",
      "sent",
      "delivery_uncertain",
      "failed",
      "cancelled",
    ]),
    recipientSuppressed: z.boolean(),
    accountDomainSuppressed: z.boolean().optional(),
    mailboxRequired: z.boolean(),
    mailboxStatus: z
      .enum(["pending", "available", "degraded", "disconnected", "revoked"])
      .nullable(),
    providerMatches: z.boolean().optional(),
    stepAlreadySent: z.boolean(),
    expectedStepMatches: z.boolean().optional(),
    terminalReply: z.boolean().optional(),
    unsubscribed: z.boolean().optional(),
    hardBounced: z.boolean().optional(),
    manuallyStopped: z.boolean().optional(),
    emergencyPaused: z.boolean().optional(),
    withinWorkingHours: z.boolean().optional(),
    mailboxDailySent: z.number().int().min(0).optional(),
    mailboxDailyCap: z.number().int().min(0).optional(),
    campaignDailySent: z.number().int().min(0).optional(),
    campaignDailyCap: z.number().int().min(0).optional(),
    mailboxMinimumDelaySatisfied: z.boolean().optional(),
    contactMinimumDelaySatisfied: z.boolean().optional(),
    recentContactCooldownSatisfied: z.boolean().optional(),
    professionalRelevanceRequired: z.boolean().optional(),
    professionallyRelevant: z.boolean().optional(),
    replyPending: z.boolean().optional(),
  })
  .strict();

const metricThresholdsSchema = z
  .object(
    Object.fromEntries(
      EVALUATION_METRIC_NAMES.map((name) => [name, z.number().min(0).max(1)]),
    ) as Record<EvaluationMetricName, z.ZodNumber>,
  )
  .strict();

const emailReasonSchema = z.enum([
  "insufficient_public_evidence",
  "low_confidence",
  "mx_missing",
]);

export const evaluationFixtureSchema = z
  .object({
    fixtureVersion: z.literal("v1"),
    dataset: z.string().trim().min(1).max(200),
    thresholds: metricThresholdsSchema,
    fixtureProvenance: z
      .object({
        method: z.enum(["synthetic_contract", "human_verified_capture"]),
        description: z.string().trim().min(1).max(1_000),
        independentlyVerified: z.boolean(),
      })
      .strict(),
    prospects: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            capture: z
              .object({
                provider: z.string().trim().min(1),
                model: z.string().trim().min(1),
                promptVersion: z.string().trim().min(1),
                schemaVersion: z.string().trim().min(1),
              })
              .strict(),
            expected: z
              .object({
                accountKey: z.string().trim().min(1),
                personKey: z.string().trim().min(1),
                companyAccountKey: z.string().trim().min(1),
                jobTitle: z.string().trim().min(1),
                requiredEvidenceSupports: z
                  .array(z.string().trim().min(1))
                  .min(1),
                acceptedEvidence: z
                  .array(
                    z
                      .object({
                        support: z.string().trim().min(1),
                        sourceUrl: httpUrlSchema,
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
            observed: z
              .object({
                accountKey: z.string().trim().min(1).nullable(),
                personKey: z.string().trim().min(1).nullable(),
                companyAccountKey: z.string().trim().min(1).nullable(),
                jobTitle: z.string().trim().min(1).nullable(),
                evidence: z.array(
                  z
                    .object({
                      url: httpUrlSchema,
                      supports: z.array(z.string().trim().min(1)).min(1),
                    })
                    .strict(),
                ),
                personalization: z
                  .object({
                    value: z.string().trim().min(1),
                    sourceUrls: z.array(httpUrlSchema).min(1),
                    accepted: z.boolean(),
                  })
                  .strict()
                  .nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(100),
    emails: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            firstName: z.string().trim().min(1),
            lastName: z.string().trim().min(1),
            domain: z.string().trim().min(1),
            publicSamples: z.array(publicEmailSampleSchema),
            mxValid: z.boolean(),
            confidenceThreshold: z.number().min(0).max(1),
            expectedEmail: z.string().trim().min(3).nullable(),
            expectedConfidence: z
              .object({
                min: z.number().min(0).max(1),
                max: z.number().min(0).max(1),
              })
              .strict()
              .refine((range) => range.min <= range.max, {
                message: "Confidence minimum must not exceed maximum",
              }),
            expectedReason: emailReasonSchema.nullable(),
          })
          .strict(),
      )
      .min(1),
    replies: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            input: z
              .object({
                subject: z.string(),
                body: z.string(),
                sender: z.string().trim().min(1),
              })
              .strict(),
            bounceKind: z.enum(["hard", "soft"]).nullable(),
            holdNonTerminal: z.boolean(),
            observedCategory: z.enum(REPLY_CATEGORIES).optional(),
            expectedCategory: z.enum(REPLY_CATEGORIES),
            expectedTerminal: z.boolean(),
            expectedSuppression: z.boolean(),
            expectedState: z
              .enum(["replied", "bounced", "opted_out", "manual_review"])
              .nullable()
              .optional(),
            expectedStopReason: z
              .enum([
                "positive_reply",
                "negative_reply",
                "question",
                "referral",
                "unsubscribe",
                "hard_bounce",
              ])
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .min(1),
    policies: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            input: sendPolicyInputSchema,
            expected: z.enum(["ALLOW", ...SEND_POLICY_BLOCK_CODES]),
          })
          .strict(),
      )
      .min(1),
    duplicates: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            kind: z.enum([
              "company_domain",
              "company_name",
              "contact_url",
              "email",
              "person_name",
            ]),
            values: z.array(z.string().trim().min(1)).min(2),
            expectedUniqueCount: z.number().int().min(1),
          })
          .strict()
          .refine((item) => item.expectedUniqueCount <= item.values.length, {
            message: "Expected unique count cannot exceed input count",
          }),
      )
      .min(1),
  })
  .strict();

export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;

export type EvaluationMetric = {
  value: number;
  numerator: number;
  denominator: number;
  threshold: number;
  passed: boolean;
};

export type EvaluationReport = {
  fixtureVersion: "v1";
  dataset: string;
  metrics: Record<EvaluationMetricName, EvaluationMetric>;
  duplicatesPrevented: number;
  prospectCases: number;
  fixtureProvenance: EvaluationFixture["fixtureProvenance"];
  failures: string[];
  passed: boolean;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * The identity a contact URL collapses to.
 *
 * LinkedIn goes through the production canonicaliser, because that is what the
 * application deduplicates on and an evaluation that certifies duplicate
 * prevention with a weaker rule certifies the wrong thing: `fr.linkedin.com`
 * and `www.linkedin.com` are one person to the database, and would have been
 * two to this harness. Everything else keeps the generic normalisation, since
 * no other host family has a canonical form the product commits to.
 */
function normalizeWebIdentity(value: string): string {
  const linkedin = canonicalLinkedInUrl(value);
  if (linkedin) return linkedin;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Identity URL must use HTTP or HTTPS");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function duplicateNormalizer(
  kind: EvaluationFixture["duplicates"][number]["kind"],
): (value: string) => string {
  switch (kind) {
    case "company_domain":
      return normalizeDomain;
    case "company_name":
      return normalizeCompanyName;
    case "contact_url":
      return normalizeWebIdentity;
    case "email":
      return normalizeEmail;
    case "person_name":
      return normalizePersonName;
  }
}

function toMetric(
  numerator: number,
  denominator: number,
  threshold: number,
): EvaluationMetric {
  const value = ratio(numerator, denominator);
  return {
    value,
    numerator,
    denominator,
    threshold,
    passed: value >= threshold,
  };
}

export async function evaluateFixture(
  rawFixture: EvaluationFixture,
): Promise<EvaluationReport> {
  const fixture = evaluationFixtureSchema.parse(rawFixture);
  const observedAccounts = fixture.prospects.filter(
    (prospect) => prospect.observed.accountKey !== null,
  );
  const correctAccounts = observedAccounts.filter(
    (prospect) =>
      normalizeDomain(prospect.observed.accountKey!) ===
      normalizeDomain(prospect.expected.accountKey),
  ).length;
  const observedContacts = fixture.prospects.filter(
    (prospect) => prospect.observed.personKey !== null,
  );
  const correctContacts = observedContacts.filter(
    (prospect) =>
      normalizeWebIdentity(prospect.observed.personKey!) ===
        normalizeWebIdentity(prospect.expected.personKey) &&
      prospect.observed.companyAccountKey !== null &&
      normalizeDomain(prospect.observed.companyAccountKey) ===
        normalizeDomain(prospect.expected.companyAccountKey) &&
      prospect.observed.jobTitle !== null &&
      normalizePersonName(prospect.observed.jobTitle) ===
        normalizePersonName(prospect.expected.jobTitle),
  ).length;
  let requiredEvidenceCount = 0;
  let supportedEvidenceCount = 0;
  for (const prospect of fixture.prospects) {
    const observedPairs = new Set(
      prospect.observed.evidence.flatMap((evidence) =>
        evidence.supports.map((support) => `${support}\u0000${evidence.url}`),
      ),
    );
    const acceptedPairs = new Set(
      prospect.expected.acceptedEvidence.map(
        (evidence) => `${evidence.support}\u0000${evidence.sourceUrl}`,
      ),
    );
    for (const required of prospect.expected.requiredEvidenceSupports) {
      requiredEvidenceCount += 1;
      if (
        [...observedPairs].some(
          (pair) =>
            pair.startsWith(`${required}\u0000`) && acceptedPairs.has(pair),
        )
      ) {
        supportedEvidenceCount += 1;
      }
    }
  }

  let emailMatches = 0;
  let emailConfidenceMatches = 0;
  let emailReasonMatches = 0;
  for (const emailCase of fixture.emails) {
    const patterns = inferEmailPatterns(
      emailCase.publicSamples,
      emailCase.domain,
    );
    const bestPattern = patterns[0];
    const actualEmail = bestPattern
      ? generateCandidateAddress({
          firstName: emailCase.firstName,
          lastName: emailCase.lastName,
          domain: emailCase.domain,
          pattern: bestPattern.pattern,
        })
      : null;
    const actualConfidence = bestPattern
      ? scoreEmailCandidate({
          sampleCount: bestPattern.sampleCount,
          mxValid: emailCase.mxValid,
        })
      : 0;
    const actualReason = !emailCase.mxValid
      ? "mx_missing"
      : !bestPattern
        ? "insufficient_public_evidence"
        : actualConfidence < emailCase.confidenceThreshold
          ? "low_confidence"
          : null;
    const expectedEmail = emailCase.expectedEmail
      ? normalizeEmail(emailCase.expectedEmail)
      : null;
    if (actualEmail === expectedEmail) emailMatches += 1;
    if (
      actualConfidence >= emailCase.expectedConfidence.min &&
      actualConfidence <= emailCase.expectedConfidence.max
    ) {
      emailConfidenceMatches += 1;
    }
    if (actualReason === emailCase.expectedReason) emailReasonMatches += 1;
  }

  const observedPersonalizations = fixture.prospects.flatMap((prospect) =>
    prospect.observed.personalization
      ? [prospect.observed.personalization]
      : [],
  );
  const acceptedPersonalizations = observedPersonalizations.filter(
    (personalization) => personalization.accepted,
  ).length;

  const classifier = new DeterministicReplyClassifier();
  let replyMatches = 0;
  for (const replyCase of fixture.replies) {
    const classification = await classifier.classify(replyCase.input);
    const observedCategory =
      replyCase.observedCategory ?? classification.category;
    const outcome = mapReplyOutcome(
      observedCategory,
      replyCase.bounceKind,
      replyCase.holdNonTerminal,
    );
    if (
      observedCategory === replyCase.expectedCategory &&
      outcome.terminal === replyCase.expectedTerminal &&
      outcome.suppressRecipient === replyCase.expectedSuppression &&
      (replyCase.expectedState === undefined ||
        outcome.state === replyCase.expectedState) &&
      (replyCase.expectedStopReason === undefined ||
        outcome.stopReason === replyCase.expectedStopReason)
    ) {
      replyMatches += 1;
    }
  }

  let policyMatches = 0;
  for (const policyCase of fixture.policies) {
    const result = evaluateSendPolicy(policyCase.input as SendPolicyInput);
    const actual = result.ok ? "ALLOW" : result.code;
    if (actual === policyCase.expected) policyMatches += 1;
  }

  let duplicateCasesMatched = 0;
  let duplicatesPrevented = 0;
  for (const duplicateCase of fixture.duplicates) {
    const normalizer = duplicateNormalizer(duplicateCase.kind);
    const uniqueCount = new Set(duplicateCase.values.map(normalizer)).size;
    duplicatesPrevented += duplicateCase.values.length - uniqueCount;
    if (uniqueCount === duplicateCase.expectedUniqueCount) {
      duplicateCasesMatched += 1;
    }
  }

  const metrics: Record<EvaluationMetricName, EvaluationMetric> = {
    accountPrecision: toMetric(
      correctAccounts,
      observedAccounts.length,
      fixture.thresholds.accountPrecision,
    ),
    contactPrecision: toMetric(
      correctContacts,
      observedContacts.length,
      fixture.thresholds.contactPrecision,
    ),
    evidenceSupportRate: toMetric(
      supportedEvidenceCount,
      requiredEvidenceCount,
      fixture.thresholds.evidenceSupportRate,
    ),
    emailAccuracy: toMetric(
      emailMatches,
      fixture.emails.length,
      fixture.thresholds.emailAccuracy,
    ),
    emailConfidenceAccuracy: toMetric(
      emailConfidenceMatches,
      fixture.emails.length,
      fixture.thresholds.emailConfidenceAccuracy,
    ),
    emailReasonAccuracy: toMetric(
      emailReasonMatches,
      fixture.emails.length,
      fixture.thresholds.emailReasonAccuracy,
    ),
    personalizationAcceptanceRate: toMetric(
      acceptedPersonalizations,
      observedPersonalizations.length,
      fixture.thresholds.personalizationAcceptanceRate,
    ),
    replyOutcomeAccuracy: toMetric(
      replyMatches,
      fixture.replies.length,
      fixture.thresholds.replyOutcomeAccuracy,
    ),
    policyOutcomeAccuracy: toMetric(
      policyMatches,
      fixture.policies.length,
      fixture.thresholds.policyOutcomeAccuracy,
    ),
    duplicatePreventionAccuracy: toMetric(
      duplicateCasesMatched,
      fixture.duplicates.length,
      fixture.thresholds.duplicatePreventionAccuracy,
    ),
  };
  const failures = EVALUATION_METRIC_NAMES.flatMap((name) => {
    const metric = metrics[name];
    return metric.passed
      ? []
      : [
          `${name}: ${(metric.value * 100).toFixed(2)}% is below threshold ${(
            metric.threshold * 100
          ).toFixed(2)}%`,
        ];
  });
  return {
    fixtureVersion: fixture.fixtureVersion,
    dataset: fixture.dataset,
    metrics,
    duplicatesPrevented,
    prospectCases: fixture.prospects.length,
    fixtureProvenance: fixture.fixtureProvenance,
    failures,
    passed: failures.length === 0,
  };
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const rows = EVALUATION_METRIC_NAMES.map((name) => {
    const metric = report.metrics[name];
    return `${name.padEnd(34)} ${(metric.value * 100).toFixed(2).padStart(7)}%  threshold ${(metric.threshold * 100).toFixed(2).padStart(7)}%  ${metric.passed ? "PASS" : "FAIL"}  (${metric.numerator}/${metric.denominator})`;
  });
  return [
    `Hyperoutreach evaluation ${report.fixtureVersion}: ${report.dataset}`,
    `fixtureProvenance${"".padEnd(16)} ${report.fixtureProvenance.method} (independently verified: ${report.fixtureProvenance.independentlyVerified ? "yes" : "no"})`,
    `prospectCases${"".padEnd(20)} ${String(report.prospectCases).padStart(8)}`,
    ...rows,
    `duplicatesPrevented${"".padEnd(15)} ${String(report.duplicatesPrevented).padStart(8)}`,
    `RESULT  ${report.passed ? "PASS" : "FAIL"}`,
    ...report.failures.map((failure) => `- ${failure}`),
  ].join("\n");
}

export async function runEvaluationFile(fixturePath: string): Promise<{
  report: EvaluationReport;
  output: string;
  exitCode: 0 | 1;
}> {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const fixture = evaluationFixtureSchema.parse(raw);
  const report = await evaluateFixture(fixture);
  return {
    report,
    output: formatEvaluationReport(report),
    exitCode: report.passed ? 0 : 1,
  };
}
