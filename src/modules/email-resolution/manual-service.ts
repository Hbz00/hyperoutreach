import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import {
  accounts,
  contacts,
  emailCandidates,
  stateTransitions,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  readDemotedConventions,
  readLadderSettings,
  readSuppressedAddresses,
  rewriteLadderRanks,
} from "@/modules/email-resolution/ladder-service";
import {
  normalizeDomain,
  normalizeEmail,
} from "@/modules/prospects/normalization";

const inputSchema = z.object({
  contactId: z.uuid(),
  email: z.string().trim().min(1).max(500),
  actor: z.string().trim().min(1).max(200),
});

export type AcceptManualEmailResult =
  | {
      ok: true;
      disposition: "accepted" | "already_accepted";
      candidate: typeof emailCandidates.$inferSelect;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "CONTACT_NOT_FOUND"
        | "DOMAIN_MISMATCH"
        | "EMAIL_CONFLICT"
        | "ADDRESS_DEAD"
        | "ADDRESS_SUPPRESSED"
        | "DATABASE_ERROR";
    };

export async function acceptManualEmail(
  db: AppDatabase,
  rawInput: unknown,
): Promise<AcceptManualEmailResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeEmail(parsed.data.email);
  } catch {
    return { ok: false, code: "INVALID_INPUT" };
  }
  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1);

  try {
    return await withActionLocks(
      db,
      [
        actionLockKey.contact(parsed.data.contactId),
        actionLockKey.recipient(normalizedEmail),
        actionLockKey.domain(domain),
      ],
      (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const [owner] = await tx
            .select({ contact: contacts, account: accounts })
            .from(contacts)
            .innerJoin(accounts, eq(accounts.id, contacts.accountId))
            .where(eq(contacts.id, parsed.data.contactId))
            .limit(1);
          if (!owner) return { ok: false, code: "CONTACT_NOT_FOUND" } as const;
          if (!owner.account.domain) {
            return { ok: false, code: "DOMAIN_MISMATCH" } as const;
          }
          if (normalizeDomain(owner.account.domain) !== domain) {
            return { ok: false, code: "DOMAIN_MISMATCH" } as const;
          }

          const [conflict] = await tx
            .select({
              contactId: emailCandidates.contactId,
              deadAt: emailCandidates.deadAt,
            })
            .from(emailCandidates)
            .where(eq(emailCandidates.normalizedEmail, normalizedEmail))
            .limit(1);
          if (conflict && conflict.contactId !== owner.contact.id) {
            return { ok: false, code: "EMAIL_CONFLICT" } as const;
          }

          /**
           * Delivery has already proven this address does not exist.
           *
           * Corroborating an address by hand is the operator's strongest move
           * and this path deliberately overrides confidence, MX and evidence —
           * but a hard bounce is not a weak signal to override, it is the one
           * fact this product can establish about an address. Accepting it again
           * would draft a message the ladder exists to avoid, and nothing in the
           * schema forbids `accepted` with `dead_at` set.
           */
          if (conflict?.deadAt) {
            return { ok: false, code: "ADDRESS_DEAD" } as const;
          }
          const [already] = await tx
            .select()
            .from(emailCandidates)
            .where(
              and(
                eq(emailCandidates.contactId, owner.contact.id),
                eq(emailCandidates.normalizedEmail, normalizedEmail),
                eq(emailCandidates.status, "accepted"),
              ),
            )
            .limit(1);
          if (already) {
            /**
             * An address accepted before it was suppressed is still blocked.
             *
             * This path writes nothing, so it is the only place that can answer
             * for it — the write below, which carries the same condition, is
             * never reached. Returning "already accepted" would tell the
             * operator the thing they asked for is in place while every send to
             * it is refused, which is exactly the silent refusal this whole
             * check exists to move earlier.
             */
            const blocked = await readSuppressedAddresses(tx, {
              addresses: [normalizedEmail],
              domain,
            });
            if (blocked.has(normalizedEmail)) {
              return { ok: false, code: "ADDRESS_SUPPRESSED" } as const;
            }
            return {
              ok: true,
              disposition: "already_accepted",
              candidate: already,
            } as const;
          }

          await tx
            .update(emailCandidates)
            .set({ status: "rejected" })
            .where(
              and(
                eq(emailCandidates.contactId, owner.contact.id),
                eq(emailCandidates.status, "accepted"),
                ne(emailCandidates.normalizedEmail, normalizedEmail),
              ),
            );
          const [existing] = await tx
            .select({ id: emailCandidates.id })
            .from(emailCandidates)
            .where(eq(emailCandidates.normalizedEmail, normalizedEmail))
            .limit(1);
          /**
           * The suppression list blocks it, so the send policy would refuse the
           * message this acceptance is about to make possible.
           *
           * Refused here rather than at send time: the operator can lift a
           * suppression, and being told which one stands in the way is the
           * decision they are actually facing.
           *
           * Only for an address with no row yet. When a row exists, the write
           * below carries the same condition and decides it in one statement —
           * asking twice would let the answer change in between, which is the
           * race this is guarding against in the first place.
           */
          if (!existing) {
            const suppressed = await readSuppressedAddresses(tx, {
              addresses: [normalizedEmail],
              domain,
            });
            if (suppressed.has(normalizedEmail)) {
              return { ok: false, code: "ADDRESS_SUPPRESSED" } as const;
            }
          }
          /**
           * Both refusals are part of the write, not only of the checks above.
           *
           * The reads that guard this path take no row lock, and neither
           * transaction that can invalidate them takes one either: a definite
           * refusal is recorded from a reconciliation that holds no action lock
           * at all, and it writes the suppression and the death separately.
           * Re-stating both conditions in the write makes each check and its
           * write a single statement, so a death or a suppression landing
           * in between is refused rather than overwritten.
           */
          const [candidate] = existing
            ? await tx
                .update(emailCandidates)
                .set({
                  status: "accepted",
                  confidence: "1.000",
                  source: "operator_manual",
                  mxValid: null,
                  evidence: { actor: parsed.data.actor },
                  verifiedAt: new Date(),
                })
                .where(
                  and(
                    eq(emailCandidates.id, existing.id),
                    isNull(emailCandidates.deadAt),
                    sql`not exists (
                      select 1 from suppression_entries blocking
                      where (blocking.scope = 'email'
                          and blocking.normalized_value = ${normalizedEmail})
                        or (blocking.scope = 'domain'
                          and blocking.normalized_value = ${domain}))`,
                  ),
                )
                .returning()
            : await tx
                .insert(emailCandidates)
                .values({
                  contactId: owner.contact.id,
                  email: normalizedEmail,
                  normalizedEmail,
                  domain,
                  pattern: null,
                  confidence: "1.000",
                  source: "operator_manual",
                  status: "accepted",
                  mxValid: null,
                  evidence: { actor: parsed.data.actor },
                  verifiedAt: new Date(),
                })
                .returning();
          /**
           * No row means the write's own conditions refused it: the address
           * died or was suppressed while this ran. Reading back which one
           * gives the operator the same answer they would have had a moment
           * earlier, rather than a generic failure.
           */
          if (!candidate) {
            if (!existing)
              throw new Error("Manual email insert returned no row");
            const [refused] = await tx
              .select({ deadAt: emailCandidates.deadAt })
              .from(emailCandidates)
              .where(eq(emailCandidates.id, existing.id))
              .limit(1);
            return {
              ok: false,
              code: refused?.deadAt ? "ADDRESS_DEAD" : "ADDRESS_SUPPRESSED",
            } as const;
          }

          /**
           * The ladder is re-ranked, exactly as every other writer of candidates
           * does.
           *
           * A manually accepted address arrives with confidence 1.000 and no
           * rank of its own, so without this it took the schema default of one
           * and shared that rung with whatever the evidence had already put
           * there — two rung ones on one ladder, and an order the operator reads
           * as meaningful that is not.
           */
          const ladderSettings = await readLadderSettings(tx);
          const demotedPatterns = await readDemotedConventions(tx, {
            domain,
            minimumPeople: ladderSettings.demotionMinimumPeople,
            failureSharePercent: ladderSettings.demotionFailureSharePercent,
          });
          await rewriteLadderRanks(tx, {
            contactId: owner.contact.id,
            // This company's ladder only. The contact may still hold rows from a
            // former employer, and ranking those by this company's verdict would
            // be one company's delivery record reordering another's addresses.
            domain,
            demotedPatterns,
          });

          await tx
            .update(contacts)
            .set({
              status: "email_resolved",
              emailResolutionStatus: "resolved",
              emailResolutionReason: null,
              emailResolutionError: null,
              emailResolutionAttemptedAt: new Date(),
            })
            .where(eq(contacts.id, owner.contact.id));
          await tx.insert(stateTransitions).values({
            entityType: "contact",
            entityId: owner.contact.id,
            fromState: owner.contact.status,
            toState: "email_resolved",
            reason: "operator_email_accepted",
            actor: parsed.data.actor,
            metadata: { emailCandidateId: candidate.id },
          });
          return { ok: true, disposition: "accepted", candidate } as const;
        }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}
