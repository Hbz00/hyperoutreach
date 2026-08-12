import { and, eq, ne } from "drizzle-orm";
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
            .select({ contactId: emailCandidates.contactId })
            .from(emailCandidates)
            .where(eq(emailCandidates.normalizedEmail, normalizedEmail))
            .limit(1);
          if (conflict && conflict.contactId !== owner.contact.id) {
            return { ok: false, code: "EMAIL_CONFLICT" } as const;
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
                .where(eq(emailCandidates.id, existing.id))
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
          if (!candidate)
            throw new Error("Manual email insert returned no row");

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
