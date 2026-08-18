import { randomUUID } from "node:crypto";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accounts,
  agentRuns,
  contacts,
  emailCandidates,
  evidenceSources,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import type { DnsMxResolver } from "@/modules/email-resolution/dns";
import {
  generateCandidateAddress,
  inferEmailPatterns,
  scoreEmailCandidate,
} from "@/modules/email-resolution/patterns";
import {
  EmailEnrichmentTransientError,
  type EmailEnrichmentProvider,
} from "@/modules/email-resolution/providers";
import {
  normalizeDomain,
  normalizeEmail,
} from "@/modules/prospects/normalization";
import {
  isObservablePublicEmailEvidenceProvider,
  publicEmailSampleSchema,
  type PublicEmailEvidenceInput,
  type PublicEmailEvidenceProvider,
  type PublicEmailEvidenceResult,
  type PublicEmailSample,
} from "@/modules/email-resolution/public-evidence-provider";
import {
  DEFAULT_PUBLIC_EVIDENCE_TTL_MS,
  shouldReusePublicEmailEvidence,
} from "@/modules/email-resolution/evidence-freshness";
import {
  conventionEvidenceOrder,
  rankLadderRungs,
} from "@/modules/email-resolution/ladder";
import {
  readDemotedConventions,
  readLadderSettings,
  readSuppressedAddresses,
  rewriteLadderRanks,
} from "@/modules/email-resolution/ladder-service";

/**
 * The confidence an address must reach before it is accepted and sent to.
 *
 * Exported so the form that offers to override it and the probe that measures
 * against it read the same number: three hand-copied literals drift, and this
 * one decides what leaves the mailbox.
 */
export const DEFAULT_EMAIL_CONFIDENCE_THRESHOLD = 0.85;

const resolveInputSchema = z.object({
  contactId: z.uuid(),
  confidenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_EMAIL_CONFIDENCE_THRESHOLD),
  /** Ask the model again even when a recent company search is on record. */
  forcePublicSearch: z.boolean().default(false),
});

type ResolutionStatus =
  "unresolved" | "resolved" | "manual_review" | "provider_error";
export type EmailResolutionReason =
  | "missing_domain"
  | "domain_not_evidenced"
  | "insufficient_public_evidence"
  | "low_confidence"
  | "enrichment_no_result"
  | "provider_transient_error"
  | "mx_missing"
  | "mx_lookup_failure"
  | "candidate_conflict"
  | "employment_changed"
  | "stale_employment"
  | "resolution_in_progress"
  | "ladder_exhausted"
  | "ladder_limit_reached"
  | "address_suppressed";
type CandidateValue = {
  email: string;
  normalizedEmail: string;
  domain: string;
  pattern: string | null;
  confidence: number;
  source: string;
  mxValid: boolean;
  evidence: Record<string, unknown>;
};

export type ResolveContactEmailResult =
  | {
      ok: true;
      status: ResolutionStatus;
      reason: EmailResolutionReason | null;
      candidates: Array<typeof emailCandidates.$inferSelect>;
    }
  | {
      ok: false;
      code: "INVALID_INPUT" | "CONTACT_NOT_FOUND" | "DATABASE_ERROR";
      message: string;
    };

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

async function setResolutionState(
  db: AppDatabase,
  owner: { contactId: string; accountId: string; employmentVersion: number },
  status: ResolutionStatus,
  reason: EmailResolutionReason,
  error: string | null,
  attemptedAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(contacts)
    .set({
      emailResolutionStatus: status,
      emailResolutionAttemptedAt: attemptedAt,
      emailResolutionError: error,
      emailResolutionReason: reason,
      emailResolutionClaimId: null,
      emailResolutionClaimedAt: null,
      emailResolutionClaimAccountId: null,
      emailResolutionClaimEmploymentVersion: null,
      emailResolutionClaimDomain: null,
      ...(status === "resolved" ? { status: "email_resolved" as const } : {}),
    })
    .where(
      and(
        eq(contacts.id, owner.contactId),
        eq(contacts.accountId, owner.accountId),
        eq(contacts.employmentVersion, owner.employmentVersion),
      ),
    )
    .returning({ id: contacts.id });
  return Boolean(updated);
}

async function abortableProviderOperation<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Provider operation timed out")),
    timeoutMs,
  );
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function findPublicEmailEvidence(
  db: AppDatabase,
  provider: PublicEmailEvidenceProvider,
  input: PublicEmailEvidenceInput,
  timeoutMs: number,
): Promise<PublicEmailEvidenceResult> {
  if (!isObservablePublicEmailEvidenceProvider(provider)) {
    return abortableProviderOperation(timeoutMs, (signal) =>
      provider.find(input, { signal }),
    );
  }

  const runId = await startAgentRun(db, provider.auditDescriptor, input);
  try {
    const observed = await abortableProviderOperation(timeoutMs, (signal) =>
      provider.findWithAgentResult(input, { signal }),
    );
    await completeAgentRun(db, runId, observed.agentResult);
    return observed.evidence;
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    throw error;
  }
}

/**
 * The most recent successful company search on record.
 *
 * Read from the audit trail rather than a cache table: every search is already
 * written there with its full result, its domain and its completion time, so a
 * second store would be a copy that can disagree with the record. The coupling
 * is deliberately one-way and harmless — pruning audit rows costs one redundant
 * search, never a wrong answer.
 */
async function findRecordedPublicEmailEvidence(
  db: AppDatabase,
  domain: string,
): Promise<{
  samples: PublicEmailSample[];
  foundAt: Date;
  promptVersion: string;
} | null> {
  const [row] = await db
    .select({
      output: agentRuns.output,
      completedAt: agentRuns.completedAt,
      promptVersion: agentRuns.promptVersion,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agent, "public_email_evidence"),
        eq(agentRuns.status, "succeeded"),
        // A succeeded run always has a completion time, but the column is
        // nullable and Postgres sorts DESC NULLS FIRST: one row that ever
        // escaped without one would win `limit 1` forever and silently disable
        // reuse for that company. Excluding it costs nothing and removes the
        // trap rather than relying on it staying unreachable.
        isNotNull(agentRuns.completedAt),
        sql`${agentRuns.input}->>'companyDomain' = ${domain}`,
      ),
    )
    // `createdAt` breaks the tie: JavaScript stamps completion to the
    // millisecond, so two searches of the same domain in one pass can share it
    // and SQL then returns either row. Which one it returns decides whether a
    // stale or an empty result is reused, so it cannot be left to chance.
    .orderBy(desc(agentRuns.completedAt), desc(agentRuns.createdAt))
    .limit(1);
  if (!row?.completedAt) return null;
  const parsed = z
    .object({ samples: z.array(publicEmailSampleSchema) })
    .safeParse(row.output);
  if (!parsed.success) return null;
  return {
    samples: parsed.data.samples,
    foundAt: row.completedAt,
    promptVersion: row.promptVersion,
  };
}

async function setClaimedResolutionState(
  db: Pick<AppDatabase, "update">,
  contactId: string,
  claimId: string,
  status: ResolutionStatus,
  reason: EmailResolutionReason,
  error: string | null,
  attemptedAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(contacts)
    .set({
      emailResolutionStatus: status,
      emailResolutionAttemptedAt: attemptedAt,
      emailResolutionError: error,
      emailResolutionReason: reason,
      emailResolutionClaimId: null,
      emailResolutionClaimedAt: null,
      emailResolutionClaimAccountId: null,
      emailResolutionClaimEmploymentVersion: null,
      emailResolutionClaimDomain: null,
    })
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.emailResolutionClaimId, claimId),
      ),
    )
    .returning({ id: contacts.id });
  return Boolean(updated);
}

export async function resolveContactEmail(
  db: AppDatabase,
  dnsResolver: DnsMxResolver,
  enrichmentProvider: EmailEnrichmentProvider | null,
  rawInput: z.input<typeof resolveInputSchema>,
  options: {
    now?: Date;
    claimLeaseMs?: number;
    providerOperationTimeoutMs?: number;
    publicEvidenceOperationTimeoutMs?: number;
    publicEvidenceProvider?: PublicEmailEvidenceProvider | null;
    publicEvidenceTtlMs?: number;
  } = {},
): Promise<ResolveContactEmailResult> {
  const parsed = resolveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid email resolution input",
    };
  }
  const now = options.now ?? new Date();
  const claimLeaseMs = options.claimLeaseMs ?? 5 * 60_000;
  const providerOperationTimeoutMs =
    options.providerOperationTimeoutMs ?? 10_000;
  const publicEvidenceOperationTimeoutMs =
    options.publicEvidenceOperationTimeoutMs ?? providerOperationTimeoutMs;
  const claimId = randomUUID();
  const [owner] = await db
    .select({ contact: contacts, account: accounts })
    .from(contacts)
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .where(eq(contacts.id, parsed.data.contactId))
    .limit(1);
  if (!owner) {
    return {
      ok: false,
      code: "CONTACT_NOT_FOUND",
      message: "Contact not found",
    };
  }
  if (!owner.account.domain) {
    const persisted = await setResolutionState(
      db,
      {
        contactId: owner.contact.id,
        accountId: owner.contact.accountId,
        employmentVersion: owner.contact.employmentVersion,
      },
      "unresolved",
      "missing_domain",
      null,
      now,
    );
    if (!persisted) {
      return {
        ok: true,
        status: "unresolved",
        reason: "stale_employment",
        candidates: [],
      };
    }
    return {
      ok: true,
      status: "unresolved",
      reason: "missing_domain",
      candidates: [],
    };
  }
  const domain = normalizeDomain(owner.account.domain);
  const domainEvidence = await db
    .select({ supports: evidenceSources.supports })
    .from(evidenceSources)
    .where(eq(evidenceSources.accountId, owner.account.id));
  if (!domainEvidence.some((source) => source.supports.includes("domain"))) {
    const persisted = await setResolutionState(
      db,
      {
        contactId: owner.contact.id,
        accountId: owner.contact.accountId,
        employmentVersion: owner.contact.employmentVersion,
      },
      "unresolved",
      "domain_not_evidenced",
      null,
      now,
    );
    if (!persisted) {
      return {
        ok: true,
        status: "unresolved",
        reason: "stale_employment",
        candidates: [],
      };
    }
    return {
      ok: true,
      status: "unresolved",
      reason: "domain_not_evidenced",
      candidates: [],
    };
  }

  const claimed = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from contacts where id = ${owner.contact.id} for update`,
    );
    const [current] = await tx
      .select({ contact: contacts, account: accounts })
      .from(contacts)
      .innerJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(eq(contacts.id, owner.contact.id))
      .limit(1);
    if (!current) return "stale" as const;
    await tx.execute(
      sql`select id from accounts where id = ${current.account.id} for share`,
    );
    if (
      current.contact.accountId !== owner.contact.accountId ||
      current.contact.employmentVersion !== owner.contact.employmentVersion ||
      !current.account.domain ||
      normalizeDomain(current.account.domain) !== domain
    ) {
      return "stale" as const;
    }
    const fresh =
      current.contact.emailResolutionClaimId !== null &&
      current.contact.emailResolutionClaimedAt !== null &&
      now.getTime() - current.contact.emailResolutionClaimedAt.getTime() <
        claimLeaseMs;
    if (fresh) return "busy" as const;
    await tx
      .update(contacts)
      .set({
        emailResolutionClaimId: claimId,
        emailResolutionClaimedAt: now,
        emailResolutionClaimAccountId: current.contact.accountId,
        emailResolutionClaimEmploymentVersion:
          current.contact.employmentVersion,
        emailResolutionClaimDomain: domain,
      })
      .where(eq(contacts.id, current.contact.id));
    return "claimed" as const;
  });
  if (claimed !== "claimed") {
    return {
      ok: true,
      status: "unresolved",
      reason:
        claimed === "busy" ? "resolution_in_progress" : "stale_employment",
      candidates: [],
    };
  }

  let publicSamples = [] as Parameters<typeof inferEmailPatterns>[0];
  let publicEvidenceFailed = false;
  // The convention belongs to the company, so the search does too. A colleague
  // resolved earlier already asked this exact question; asking again spends a
  // web search on an answer we hold.
  // Skipped outright when the answer cannot be used: a forced search and a
  // provider that reports no version both discard the record, and the query is
  // not free.
  const recorded =
    parsed.data.forcePublicSearch || !options.publicEvidenceProvider
      ? null
      : await findRecordedPublicEmailEvidence(db, domain);
  // Taken from the provider rather than named here, so the prompt and the
  // version that gates reuse of its results can never drift apart. A provider
  // that reports no version — the deterministic fixture — matches no record
  // and simply searches, which is the safe default.
  const currentPromptVersion =
    options.publicEvidenceProvider &&
    isObservablePublicEmailEvidenceProvider(options.publicEvidenceProvider)
      ? options.publicEvidenceProvider.auditDescriptor.promptVersion
      : "";
  const reusing = shouldReusePublicEmailEvidence({
    sampleCount: recorded?.samples.length ?? 0,
    foundAt: recorded?.foundAt ?? null,
    recordedPromptVersion: recorded?.promptVersion ?? null,
    currentPromptVersion,
    now,
    ttlMs: options.publicEvidenceTtlMs ?? DEFAULT_PUBLIC_EVIDENCE_TTL_MS,
    force: parsed.data.forcePublicSearch,
  });
  let evidenceFoundAt = now;
  if (reusing && recorded) {
    publicSamples = recorded.samples;
    evidenceFoundAt = recorded.foundAt;
  } else if (options.publicEvidenceProvider) {
    try {
      const evidence = await findPublicEmailEvidence(
        db,
        options.publicEvidenceProvider,
        { companyDomain: domain },
        publicEvidenceOperationTimeoutMs,
      );
      publicSamples = evidence.samples;
    } catch {
      publicEvidenceFailed = true;
    }
  }

  let mx;
  try {
    mx = await abortableProviderOperation(
      providerOperationTimeoutMs,
      (signal) => dnsResolver.resolve(domain, { signal }),
    );
  } catch {
    const stillOwned = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from contacts where id = ${owner.contact.id} for update`,
      );
      const [current] = await tx
        .select({ contact: contacts, account: accounts })
        .from(contacts)
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(eq(contacts.id, owner.contact.id))
        .limit(1);
      if (current) {
        await tx.execute(
          sql`select id from accounts where id = ${current.account.id} for share`,
        );
      }
      if (
        !current ||
        current.contact.emailResolutionClaimId !== claimId ||
        current.contact.accountId !== owner.contact.accountId ||
        current.contact.employmentVersion !== owner.contact.employmentVersion ||
        current.contact.emailResolutionClaimAccountId !==
          owner.contact.accountId ||
        current.contact.emailResolutionClaimEmploymentVersion !==
          owner.contact.employmentVersion ||
        current.contact.emailResolutionClaimDomain !== domain ||
        !current.account.domain ||
        normalizeDomain(current.account.domain) !== domain
      ) {
        return false;
      }
      return setClaimedResolutionState(
        tx,
        owner.contact.id,
        claimId,
        "provider_error",
        "mx_lookup_failure",
        "MX lookup temporarily unavailable",
        now,
      );
    });
    if (!stillOwned) {
      return {
        ok: true,
        status: "unresolved",
        reason: "stale_employment",
        candidates: [],
      };
    }
    return {
      ok: true,
      status: "provider_error",
      reason: "mx_lookup_failure",
      candidates: [],
    };
  }

  const candidates = new Map<string, CandidateValue>();
  const patterns = inferEmailPatterns(publicSamples, domain);
  /**
   * What this company's own delivery record has already said about these
   * conventions.
   *
   * Public samples are indirect evidence — somebody's address appeared in a
   * document. A convention proven dead for several of this company's people is
   * direct evidence about the same question, and without carrying it back here
   * the next colleague would go on attempting a form just observed to fail.
   */
  const ladderSettings = await readLadderSettings(db);
  const demotedPatterns = await readDemotedConventions(db, {
    domain,
    minimumPeople: ladderSettings.demotionMinimumPeople,
    failureSharePercent: ladderSettings.demotionFailureSharePercent,
  });
  /** The rungs this contact already holds, and what delivery did to them. */
  const existingCandidates = await db
    .select({
      normalizedEmail: emailCandidates.normalizedEmail,
      deadAt: emailCandidates.deadAt,
    })
    .from(emailCandidates)
    .where(eq(emailCandidates.contactId, owner.contact.id));
  for (const pattern of patterns) {
    const email = generateCandidateAddress({
      firstName: owner.contact.firstName,
      lastName: owner.contact.lastName,
      domain,
      pattern: pattern.pattern,
    });
    const confidence = scoreEmailCandidate({
      sampleCount: pattern.sampleCount,
      mxValid: mx.hasMx,
    });
    candidates.set(email, {
      email,
      normalizedEmail: email,
      domain,
      pattern: pattern.pattern,
      confidence,
      source: "public_pattern",
      mxValid: mx.hasMx,
      evidence: {
        sourceUrls: pattern.sourceUrls,
        sampleCount: pattern.sampleCount,
        mxRecords: mx.records,
        // When the company was searched, which is not when this contact was
        // resolved: a colleague's search is reused for up to thirty days, and
        // an operator deciding whether to force a fresh one has no other way to
        // tell a search made today from one made four weeks ago.
        searchedAt: evidenceFoundAt.toISOString(),
        evidenceOrigin: reusing ? ("reused" as const) : ("searched" as const),
      },
    });
  }

  let bestConfidence = Math.max(
    0,
    ...[...candidates.values()].map((candidate) => candidate.confidence),
  );
  let providerFailed = false;
  let providerAttempted = false;
  let acceptedProviderCandidates = 0;
  if (bestConfidence < parsed.data.confidenceThreshold && enrichmentProvider) {
    providerAttempted = true;
    try {
      const enriched = await abortableProviderOperation(
        providerOperationTimeoutMs,
        (signal) =>
          enrichmentProvider.resolve(
            {
              firstName: owner.contact.firstName,
              lastName: owner.contact.lastName,
              companyDomain: domain,
            },
            { signal },
          ),
      );
      for (const candidate of enriched) {
        let normalized: string;
        try {
          normalized = normalizeEmail(candidate.email);
        } catch {
          continue;
        }
        if (emailDomain(normalized) !== domain) continue;
        const confidence = mx.hasMx
          ? candidate.confidence
          : Math.min(candidate.confidence, 0.4);
        const existing = candidates.get(normalized);
        if (existing && existing.confidence >= confidence) continue;
        acceptedProviderCandidates += 1;
        candidates.set(normalized, {
          email: normalized,
          normalizedEmail: normalized,
          domain,
          pattern: null,
          confidence,
          source: enrichmentProvider.name,
          mxValid: mx.hasMx,
          evidence: {
            provider: enrichmentProvider.name,
            sourceUrls: candidate.evidenceUrls,
            providerSource: candidate.source,
            mxRecords: mx.records,
          },
        });
      }
    } catch (error) {
      providerFailed = true;
      if (!(error instanceof EmailEnrichmentTransientError)) {
        // Provider implementations are untrusted boundaries; expose the same
        // safe operational state without persisting their raw exception.
      }
    }
    bestConfidence = Math.max(
      0,
      ...[...candidates.values()].map((candidate) => candidate.confidence),
    );
  }

  providerFailed ||= publicEvidenceFailed && candidates.size === 0;
  /**
   * The order the evidence produced, with this company's discredited
   * conventions moved to the back.
   *
   * Two addresses evidenced exactly as well as each other used to be refused
   * outright: one pattern yields one address per contact, so a tie meant the
   * company runs more than one convention and nothing said which this person
   * uses — and picking was a coin toss whose losing side was a bounce, a
   * permanent suppression and a prospect spent for nothing. Real companies do
   * this; one carrier in a ten-domain probe showed eight addresses in
   * `first.last` and three in `flast`.
   *
   * Under a ladder the coin toss is gone: the loser of a tie is rung two, reached
   * only if rung one is proven dead, and no send leaves without an operator
   * approving it. What replaces the refusal is a deterministic order — how common
   * the convention is, never which address happens to sort first alphabetically,
   * which is what the previous `localeCompare` tiebreak was deciding.
   */
  const rankedRungs = rankLadderRungs(
    [...candidates.values()].map((candidate) => ({
      normalizedEmail: candidate.normalizedEmail,
      pattern: candidate.pattern,
      confidence: candidate.confidence,
      evidenceOrder: conventionEvidenceOrder(candidate.pattern),
    })),
    demotedPatterns,
  );
  const rankedCandidates = rankedRungs.flatMap((rung) => {
    const candidate = candidates.get(rung.normalizedEmail);
    return candidate ? [{ ...candidate, ladderRank: rung.ladderRank }] : [];
  });
  /**
   * A suppression is permanent and keyed on the address alone, so a colleague's
   * failed guess can own the address this person's best convention produces.
   * Accepting it anyway put a message in the review queue that the send policy
   * would refuse for a reason nobody had been told about.
   */
  const suppressedAddresses = await readSuppressedAddresses(db, {
    addresses: rankedCandidates.map((candidate) => candidate.normalizedEmail),
    domain,
  });
  const deadAddresses = new Set(
    existingCandidates
      .filter((candidate) => candidate.deadAt !== null)
      .map((candidate) => candidate.normalizedEmail),
  );
  const acceptable = rankedCandidates.filter(
    (candidate) => candidate.confidence >= parsed.data.confidenceThreshold,
  );
  // An address proven not to exist is never re-accepted, however well the
  // convention that produced it is evidenced. Delivery said the last word.
  const notDead = acceptable.filter(
    (candidate) => !deadAddresses.has(candidate.normalizedEmail),
  );
  const bestUsable = notDead.find(
    (candidate) => !suppressedAddresses.has(candidate.normalizedEmail),
  );
  /** Everything that cleared the bar has already been tried and died. */
  const deadBlocked = acceptable.length > 0 && notDead.length === 0;
  /** Something cleared the bar and only a suppression is keeping it out. */
  const suppressionBlocked = notDead.length > 0 && bestUsable === undefined;
  const status: ResolutionStatus = providerFailed
    ? "provider_error"
    : bestUsable
      ? "resolved"
      : "manual_review";
  let persistedStatus = status;
  let persistedReason: EmailResolutionReason | null = providerFailed
    ? "provider_transient_error"
    : !mx.hasMx
      ? "mx_missing"
      : deadBlocked
        ? "ladder_exhausted"
        : suppressionBlocked
          ? "address_suppressed"
          : status === "resolved"
            ? null
            : providerAttempted && acceptedProviderCandidates === 0
              ? "enrichment_no_result"
              : patterns.length === 0
                ? "insufficient_public_evidence"
                : "low_confidence";
  try {
    const persisted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from contacts where id = ${owner.contact.id} for update`,
      );
      const [current] = await tx
        .select({ contact: contacts, account: accounts })
        .from(contacts)
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(eq(contacts.id, owner.contact.id))
        .limit(1);
      if (current) {
        await tx.execute(
          sql`select id from accounts where id = ${current.account.id} for share`,
        );
      }
      if (
        !current ||
        current.contact.emailResolutionClaimId !== claimId ||
        current.contact.accountId !== owner.contact.accountId ||
        current.contact.employmentVersion !== owner.contact.employmentVersion ||
        current.contact.emailResolutionClaimAccountId !==
          owner.contact.accountId ||
        current.contact.emailResolutionClaimEmploymentVersion !==
          owner.contact.employmentVersion ||
        current.contact.emailResolutionClaimDomain !== domain ||
        !current.account.domain ||
        normalizeDomain(current.account.domain) !== domain
      ) {
        if (current?.contact.emailResolutionClaimId === claimId) {
          await tx
            .update(contacts)
            .set({
              emailResolutionStatus: "unresolved",
              emailResolutionReason: "stale_employment",
              emailResolutionClaimId: null,
              emailResolutionClaimedAt: null,
              emailResolutionClaimAccountId: null,
              emailResolutionClaimEmploymentVersion: null,
              emailResolutionClaimDomain: null,
            })
            .where(eq(contacts.id, current.contact.id));
        }
        return false;
      }
      for (const candidate of rankedCandidates) {
        await tx
          .insert(emailCandidates)
          .values({
            contactId: owner.contact.id,
            email: candidate.email,
            normalizedEmail: candidate.normalizedEmail,
            domain: candidate.domain,
            pattern: candidate.pattern,
            confidence: candidate.confidence.toFixed(3),
            source: candidate.source,
            status: "candidate",
            mxValid: candidate.mxValid,
            evidence: candidate.evidence,
            verifiedAt: now,
            ladderRank: candidate.ladderRank,
          })
          .onConflictDoNothing();
        await tx
          .update(emailCandidates)
          .set({
            confidence: candidate.confidence.toFixed(3),
            source: candidate.source,
            // `status` is deliberately absent. Acceptance is decided below and
            // demotes whatever was accepted before, so resetting it here was
            // always redundant — and it would revive a candidate the ladder
            // rejected for being proven dead, which no amount of fresh evidence
            // about its convention makes true again.
            mxValid: candidate.mxValid,
            evidence: candidate.evidence,
            verifiedAt: now,
            ladderRank: candidate.ladderRank,
          })
          .where(
            and(
              eq(emailCandidates.contactId, owner.contact.id),
              eq(emailCandidates.normalizedEmail, candidate.normalizedEmail),
            ),
          );
      }
      /**
       * An address that has already been written to and has not been proven dead
       * keeps its acceptance, whatever this pass found.
       *
       * The prospect may be holding the message sent to it. Moving acceptance
       * would make that message unsendable — the send policy checks the
       * recipient is still the accepted candidate — and could end with two
       * addresses used for one human, which the whole send policy exists to
       * prevent.
       */
      /**
       * The state that decides acceptance is re-read here, inside the
       * transaction that holds this contact's row, and not taken from the
       * snapshot the status above was computed from.
       *
       * Nothing fences the ladder against a resolution in flight: a hard bounce
       * or a definite SMTP refusal commits its own transaction, and the staleness
       * checks this claim performs — account, employment version, domain — are
       * all still true after an address dies. So a resolution that started a
       * second earlier would otherwise write `accepted` back onto a row delivery
       * has just proven does not exist. The pre-transaction reads stay: they
       * decide the *reported* reason, which does not have to be atomic. This
       * decides what is written, which does.
       */
      const ownedRows = await tx
        .select({
          normalizedEmail: emailCandidates.normalizedEmail,
          status: emailCandidates.status,
          firstAttemptedAt: emailCandidates.firstAttemptedAt,
          deadAt: emailCandidates.deadAt,
        })
        .from(emailCandidates)
        .where(eq(emailCandidates.contactId, owner.contact.id));
      const suppressedNow = await readSuppressedAddresses(tx, {
        addresses: ownedRows.map((row) => row.normalizedEmail),
        domain,
      });
      const ownedRow = (email: string) =>
        ownedRows.find((candidate) => candidate.normalizedEmail === email);
      /** Dead or suppressed: either one makes an address unacceptable now. */
      const blockedNow = (email: string): boolean =>
        Boolean(ownedRow(email)?.deadAt) || suppressedNow.has(email);
      /**
       * An address that is no longer usable does not stay accepted.
       *
       * `prepareCommand` reads the accepted candidate directly to address a
       * queued message, without consulting the contact's resolution status. An
       * `accepted` row left behind by a resolution that has since concluded "no
       * usable address" therefore spends an agent turn drafting a message the
       * send policy then refuses — the silent refusal at send time this whole
       * area exists to remove.
       */
      for (const row of ownedRows) {
        if (row.status !== "accepted" || !blockedNow(row.normalizedEmail)) {
          continue;
        }
        await tx
          .update(emailCandidates)
          .set({ status: "rejected" })
          .where(
            and(
              eq(emailCandidates.contactId, owner.contact.id),
              eq(emailCandidates.normalizedEmail, row.normalizedEmail),
            ),
          );
      }
      const pinned = ownedRows.find(
        (row) =>
          row.status === "accepted" &&
          row.firstAttemptedAt !== null &&
          !blockedNow(row.normalizedEmail),
      );
      if (pinned) {
        persistedStatus = "resolved";
        persistedReason = null;
      } else {
        // The global `normalized_email` uniqueness means a generated address can
        // already belong to another contact, in which case this contact does not
        // own the row and cannot accept it. That, and not a tie, is what
        // `candidate_conflict` now means.
        const ownedAcceptable = acceptable.filter((candidate) =>
          ownedRow(candidate.normalizedEmail),
        );
        const accepted = ownedAcceptable.find(
          (candidate) => !blockedNow(candidate.normalizedEmail),
        );
        if (accepted) {
          await tx
            .update(emailCandidates)
            .set({ status: "candidate" })
            .where(
              and(
                eq(emailCandidates.contactId, owner.contact.id),
                eq(emailCandidates.status, "accepted"),
              ),
            );
          await tx
            .update(emailCandidates)
            .set({ status: "accepted" })
            .where(
              and(
                eq(emailCandidates.contactId, owner.contact.id),
                eq(emailCandidates.normalizedEmail, accepted.normalizedEmail),
              ),
            );
          persistedStatus = "resolved";
          persistedReason = null;
        } else if (status === "resolved") {
          // The snapshot said yes and the transaction says no, so the address
          // the report would have named is gone. Say why rather than reporting a
          // resolution that did not happen.
          persistedStatus = "manual_review";
          persistedReason =
            ownedAcceptable.length === 0
              ? // Nothing this contact owns cleared the bar: the address the
                // evidence points at belongs to somebody else.
                "candidate_conflict"
              : ownedAcceptable.some((candidate) =>
                    suppressedNow.has(candidate.normalizedEmail),
                  )
                ? "address_suppressed"
                : "ladder_exhausted";
        }
      }
      await rewriteLadderRanks(tx, {
        contactId: owner.contact.id,
        domain,
        demotedPatterns,
      });
      await tx
        .update(contacts)
        .set({
          emailResolutionStatus: persistedStatus,
          emailResolutionAttemptedAt: now,
          emailResolutionError: providerFailed
            ? "Email enrichment temporarily unavailable"
            : null,
          emailResolutionReason: persistedReason,
          emailResolutionClaimId: null,
          emailResolutionClaimedAt: null,
          emailResolutionClaimAccountId: null,
          emailResolutionClaimEmploymentVersion: null,
          emailResolutionClaimDomain: null,
          ...(persistedStatus === "resolved"
            ? { status: "email_resolved" as const }
            : {}),
        })
        .where(eq(contacts.id, owner.contact.id));
      return true;
    });
    if (!persisted) {
      return {
        ok: true,
        status: "unresolved",
        reason: "stale_employment",
        candidates: [],
      };
    }
    const persistedCandidates = await db
      .select()
      .from(emailCandidates)
      .where(eq(emailCandidates.contactId, owner.contact.id));
    return {
      ok: true,
      status: persistedStatus,
      reason: persistedReason,
      candidates: persistedCandidates,
    };
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save email resolution",
    };
  }
}
