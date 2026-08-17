import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accounts,
  contacts,
  emailCandidates,
  enrollments,
  evidenceSources,
  stateTransitions,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { ContactDiscoveryAgent } from "@/modules/agents/contracts";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import {
  contactDiscoveryInputSchema,
  contactDiscoveryOutputSchema,
  type ContactDiscoveryOutput,
} from "@/modules/agents/schemas";
import {
  canonicalLinkedInUrl,
  parseContactInput,
} from "@/modules/contacts/input";
import {
  normalizeProvenanceUrl,
  validateContactDiscoveryProvenance,
} from "@/modules/agents/provenance";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";

const serviceInputSchema = z.object({
  accountId: z.uuid(),
  roles: z.array(z.string().trim().min(2).max(300)).min(1).max(50),
  limit: z.number().int().min(1).max(100),
});

type Contact = typeof contacts.$inferSelect;
type Candidate = ContactDiscoveryOutput["contacts"][number];
type Conflict = {
  contactId: string;
  code: "CURRENT_EMPLOYMENT_UNVERIFIED";
};

export type DiscoverContactsResult =
  | {
      ok: true;
      contacts: Contact[];
      conflicts: Conflict[];
      agentRunId: string;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "ACCOUNT_NOT_FOUND"
        | "AGENT_ERROR"
        | "DATABASE_ERROR";
      message: string;
    };

export async function discoverContacts(
  db: AppDatabase,
  agent: ContactDiscoveryAgent,
  rawInput: z.input<typeof serviceInputSchema>,
): Promise<DiscoverContactsResult> {
  const parsed = serviceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid contact discovery input",
    };
  }
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, parsed.data.accountId))
    .limit(1);
  if (!account) {
    return {
      ok: false,
      code: "ACCOUNT_NOT_FOUND",
      message: "Account not found",
    };
  }
  const agentInput = contactDiscoveryInputSchema.parse({
    account: { id: account.id, name: account.name, domain: account.domain },
    roles: parsed.data.roles,
    limit: parsed.data.limit,
  });
  let runId: string;
  try {
    runId = await startAgentRun(db, agent, agentInput);
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not start contact discovery",
    };
  }
  let result;
  try {
    result = await agent.discover(agentInput);
    contactDiscoveryOutputSchema.parse(result.output);
    if (result.output.contacts.length > parsed.data.limit) {
      throw new Error("Contact discovery exceeded requested output limit");
    }
    validateContactDiscoveryProvenance(result);
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "AGENT_ERROR",
      message: "Contact discovery failed",
    };
  }
  const evidenceObservedAt = new Date();
  try {
    const prepared = result.output.contacts.map((candidate) => ({
      candidate,
      input: parseContactInput({
        accountId: account.id,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        jobTitle: candidate.jobTitle,
        linkedinUrl: candidate.linkedinUrl,
        professionalRelevance: {
          relevant: true,
          targetRoles: parsed.data.roles,
          confidence: candidate.confidence,
        },
      }),
    }));
    const linkedinUrls = prepared.flatMap(({ input }) =>
      input.linkedinUrl ? [input.linkedinUrl] : [],
    );
    const knownContacts =
      linkedinUrls.length === 0
        ? []
        : await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(inArray(contacts.linkedinUrl, linkedinUrls));
    const batch = await withActionLocks(
      db,
      knownContacts.map((contact) => actionLockKey.contact(contact.id)),
      (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const persisted: Contact[] = [];
          const conflicts: Conflict[] = [];
          for (const { candidate, input } of prepared) {
            if (input.linkedinUrl) {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.linkedinUrl}, 0))`,
              );
            }
            let [stored] = input.linkedinUrl
              ? await tx
                  .select()
                  .from(contacts)
                  .where(eq(contacts.linkedinUrl, input.linkedinUrl))
                  .limit(1)
              : await tx
                  .select()
                  .from(contacts)
                  .where(
                    and(
                      eq(contacts.accountId, account.id),
                      eq(contacts.normalizedFullName, input.normalizedFullName),
                      isNull(contacts.linkedinUrl),
                    ),
                  )
                  .limit(1)
                  .for("update");
            if (stored) {
              // Resolve the stable identity inside the LinkedIn-serialized
              // transaction, then share the exact send-side contact lock. This
              // also covers a contact created after the pre-lock lookup.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${actionLockKey.contact(stored.id)}, 0))`,
              );
            }
            if (
              stored &&
              stored.accountId !== account.id &&
              !hasValidatedCurrentEmployment(
                candidate,
                account.domain,
                input.linkedinUrl,
              )
            ) {
              conflicts.push({
                contactId: stored.id,
                code: "CURRENT_EMPLOYMENT_UNVERIFIED" as const,
              });
              continue;
            }
            const previousAccountId = stored?.accountId;
            const employmentChanged = Boolean(
              previousAccountId && previousAccountId !== account.id,
            );
            const invalidatedCandidates = employmentChanged
              ? await tx
                  .update(emailCandidates)
                  .set({ status: "rejected" })
                  .where(eq(emailCandidates.contactId, stored!.id))
                  .returning({ id: emailCandidates.id })
              : [];
            const affectedEnrollments = employmentChanged
              ? await tx
                  .select({ id: enrollments.id, state: enrollments.state })
                  .from(enrollments)
                  .where(
                    and(
                      eq(enrollments.contactId, stored!.id),
                      notInArray(enrollments.state, [
                        "replied",
                        "bounced",
                        "opted_out",
                        "completed",
                        "stopped",
                        "failed",
                      ]),
                    ),
                  )
                  .for("update")
              : [];
            if (stored) {
              [stored] = await tx
                .update(contacts)
                .set({
                  accountId: account.id,
                  jobTitle: candidate.jobTitle,
                  professionalRelevance: input.professionalRelevance,
                  linkedinUrl: input.linkedinUrl ?? stored.linkedinUrl,
                  ...(employmentChanged
                    ? {
                        status: "discovered" as const,
                        emailResolutionStatus: "unresolved" as const,
                        emailResolutionAttemptedAt: null,
                        emailResolutionError: null,
                        emailResolutionReason: "employment_changed" as const,
                        employmentVersion: sql`${contacts.employmentVersion} + 1`,
                        emailResolutionClaimId: null,
                        emailResolutionClaimedAt: null,
                        emailResolutionClaimAccountId: null,
                        emailResolutionClaimEmploymentVersion: null,
                        emailResolutionClaimDomain: null,
                      }
                    : {}),
                })
                .where(eq(contacts.id, stored.id))
                .returning();
            } else {
              if (input.linkedinUrl) {
                const [weak] = await tx
                  .select()
                  .from(contacts)
                  .where(
                    and(
                      eq(contacts.accountId, account.id),
                      eq(contacts.normalizedFullName, input.normalizedFullName),
                      isNull(contacts.linkedinUrl),
                    ),
                  )
                  .limit(1)
                  .for("update");
                if (weak) {
                  [stored] = await tx
                    .update(contacts)
                    .set({
                      linkedinUrl: input.linkedinUrl,
                      jobTitle: input.jobTitle ?? weak.jobTitle,
                      professionalRelevance: input.professionalRelevance,
                    })
                    .where(eq(contacts.id, weak.id))
                    .returning();
                }
              }
              if (!stored) {
                [stored] = await tx.insert(contacts).values(input).returning();
              }
            }
            if (!stored) throw new Error("Contact persistence returned no row");
            if (previousAccountId && previousAccountId !== account.id) {
              if (affectedEnrollments.length > 0) {
                const stoppedAt = new Date();
                await tx
                  .update(enrollments)
                  .set({
                    state: "stopped",
                    stopReason: "employment_changed",
                    stoppedAt,
                    nextActionAt: null,
                    nextActionToken: null,
                    workflowClaimId: null,
                    workflowClaimedAt: null,
                    inboundHoldCount: 0,
                    inboundHoldAt: null,
                    inboundHoldPreviousState: null,
                    inboundHoldPreviousNextActionAt: null,
                    inboundHoldPreviousNextActionToken: null,
                  })
                  .where(
                    inArray(
                      enrollments.id,
                      affectedEnrollments.map((enrollment) => enrollment.id),
                    ),
                  );
                await tx.insert(stateTransitions).values(
                  affectedEnrollments.map((enrollment) => ({
                    entityType: "enrollment",
                    entityId: enrollment.id,
                    fromState: enrollment.state,
                    toState: "stopped",
                    reason: "employment_changed",
                    metadata: {
                      contactId: stored!.id,
                      oldAccountId: previousAccountId,
                      newAccountId: account.id,
                    },
                  })),
                );
              }
              await tx.insert(stateTransitions).values({
                entityType: "contact_employment",
                entityId: stored.id,
                fromState: previousAccountId,
                toState: account.id,
                reason: "validated_current_employment",
                metadata: {
                  agentRunId: runId,
                  jobTitle: candidate.jobTitle,
                  oldAccountId: previousAccountId,
                  newAccountId: account.id,
                  invalidatedEmailCandidateCount: invalidatedCandidates.length,
                  stoppedEnrollmentCount: affectedEnrollments.length,
                },
              });
            }
            for (const source of candidate.evidence) {
              await tx
                .insert(evidenceSources)
                .values({
                  contactId: stored.id,
                  url: source.url,
                  title: source.title,
                  sourceType: "contact_discovery",
                  retrievedAt: evidenceObservedAt,
                  supports: source.supports,
                  confidence: candidate.confidence.toFixed(3),
                  metadata: { agentRunId: runId },
                })
                .onConflictDoUpdate({
                  target: [evidenceSources.contactId, evidenceSources.url],
                  targetWhere: sql`${evidenceSources.contactId} is not null`,
                  set: {
                    title: source.title,
                    sourceType: "contact_discovery",
                    retrievedAt: evidenceObservedAt,
                    supports: source.supports,
                    confidence: candidate.confidence.toFixed(3),
                    metadata: { agentRunId: runId },
                  },
                });
            }
            persisted.push(stored);
          }
          await completeAgentRun(tx, runId, result);
          return { persisted, conflicts };
        }),
    );
    return {
      ok: true,
      contacts: [
        ...new Map(
          batch.persisted.map((contact) => [contact.id, contact]),
        ).values(),
      ],
      conflicts: batch.conflicts,
      agentRunId: runId,
    };
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save contacts",
    };
  }
}

function hasValidatedCurrentEmployment(
  candidate: Candidate,
  accountDomain: string | null,
  storedLinkedinUrl: string | null,
): boolean {
  // Canonicalised on both sides, not merely provenance-normalised. The stored
  // identity is always `www.linkedin.com/in/<lowercase-slug>`, while an agent
  // reporting a French profile hands back `fr.linkedin.com/in/Victor-Guyon`.
  // `normalizeProvenanceUrl` only lower-cases the host, so those two compared
  // unequal and a LinkedIn page proving the employment counted for nothing —
  // leaving an employer move looking unevidenced and recording a conflict
  // instead of repinning the contact.
  const linkedin = storedLinkedinUrl
    ? canonicalLinkedInUrl(storedLinkedinUrl)
    : null;
  return candidate.evidence.some((source) => {
    if (!source.supports.includes("employment")) return false;
    const normalized = normalizeProvenanceUrl(source.url);
    if (linkedin && canonicalLinkedInUrl(source.url) === linkedin) return true;
    if (!accountDomain) return false;
    const hostname = new URL(normalized).hostname;
    return hostname === accountDomain || hostname.endsWith(`.${accountDomain}`);
  });
}
