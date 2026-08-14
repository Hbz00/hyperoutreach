import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accounts,
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
  type PublicEmailEvidenceInput,
  type PublicEmailEvidenceProvider,
  type PublicEmailEvidenceResult,
} from "@/modules/email-resolution/public-evidence-provider";

const resolveInputSchema = z.object({
  contactId: z.uuid(),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
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
  | "resolution_in_progress";
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
  if (options.publicEvidenceProvider) {
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
  const status: ResolutionStatus = providerFailed
    ? "provider_error"
    : bestConfidence >= parsed.data.confidenceThreshold
      ? "resolved"
      : "manual_review";
  const rankedCandidates = [...candidates.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.normalizedEmail.localeCompare(right.normalizedEmail),
  );
  let persistedStatus = status;
  let persistedReason: EmailResolutionReason | null = providerFailed
    ? "provider_transient_error"
    : !mx.hasMx
      ? "mx_missing"
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
      for (const candidate of candidates.values()) {
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
          })
          .onConflictDoNothing();
        await tx
          .update(emailCandidates)
          .set({
            confidence: candidate.confidence.toFixed(3),
            source: candidate.source,
            status: "candidate",
            mxValid: candidate.mxValid,
            evidence: candidate.evidence,
            verifiedAt: now,
          })
          .where(
            and(
              eq(emailCandidates.contactId, owner.contact.id),
              eq(emailCandidates.normalizedEmail, candidate.normalizedEmail),
            ),
          );
      }
      if (status === "resolved") {
        const ownedCandidates = await tx
          .select({ normalizedEmail: emailCandidates.normalizedEmail })
          .from(emailCandidates)
          .where(eq(emailCandidates.contactId, owner.contact.id));
        const ownedEmails = new Set(
          ownedCandidates.map((candidate) => candidate.normalizedEmail),
        );
        const accepted = rankedCandidates.find(
          (candidate) =>
            candidate.confidence >= parsed.data.confidenceThreshold &&
            ownedEmails.has(candidate.normalizedEmail),
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
        } else {
          persistedStatus = "manual_review";
          persistedReason = "candidate_conflict";
        }
      }
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
