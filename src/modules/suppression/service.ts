import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { stateTransitions, suppressionEntries } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import { normalizeSuppressionTarget } from "@/modules/suppression/normalization";

const addSchema = z.object({
  scope: z.enum(["email", "domain"]),
  value: z.string().trim().min(1).max(500),
  reason: z.enum(["unsubscribe", "hard_bounce", "manual", "legal"]),
  actor: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2_000).optional(),
  sourceReplyId: z.uuid().optional(),
});
const removeSchema = z.object({
  id: z.uuid(),
  actor: z.string().trim().min(1).max(200),
  justification: z.string().trim().min(3).max(2_000).optional(),
  confirmedResubscription: z.boolean().optional(),
  verifiedAddressOverride: z.boolean().optional(),
});

type Entry = typeof suppressionEntries.$inferSelect;
type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

const suppressionPrecedence = {
  manual: 1,
  hard_bounce: 2,
  legal: 3,
  unsubscribe: 4,
} as const;

export async function insertSuppressionInTransaction(
  tx: Transaction,
  input: {
    scope: "email" | "domain";
    normalizedValue: string;
    reason: "unsubscribe" | "hard_bounce" | "manual" | "legal";
    actor: string;
    notes?: string;
    sourceReplyId?: string;
    sourceInboundRecordId?: string;
  },
): Promise<{ disposition: "created" | "existing"; entry: Entry }> {
  const [created] = await tx
    .insert(suppressionEntries)
    .values({
      scope: input.scope,
      normalizedValue: input.normalizedValue,
      reason: input.reason,
      sourceReplyId: input.sourceReplyId,
      notes: input.notes,
    })
    .onConflictDoNothing()
    .returning();
  const [entry] = created
    ? [created]
    : await tx
        .select()
        .from(suppressionEntries)
        .where(
          and(
            eq(suppressionEntries.scope, input.scope),
            eq(suppressionEntries.normalizedValue, input.normalizedValue),
          ),
        )
        .limit(1);
  if (!entry) throw new Error("Suppression conflict could not be reconciled");
  const upgrade =
    !created &&
    suppressionPrecedence[input.reason] > suppressionPrecedence[entry.reason];
  const effectiveEntry = upgrade
    ? (
        await tx
          .update(suppressionEntries)
          .set({
            reason: input.reason,
            sourceReplyId: input.sourceReplyId,
            notes: input.notes,
          })
          .where(eq(suppressionEntries.id, entry.id))
          .returning()
      )[0]!
    : entry;
  if (created) {
    await tx.insert(stateTransitions).values({
      entityType: "suppression",
      entityId: entry.id,
      fromState: null,
      toState: "active",
      reason: input.reason,
      actor: input.actor,
      metadata: {
        scope: entry.scope,
        normalizedValue: input.normalizedValue,
        sourceReplyId: input.sourceReplyId,
        sourceInboundRecordId: input.sourceInboundRecordId,
      },
    });
  }
  if (upgrade) {
    await tx.insert(stateTransitions).values({
      entityType: "suppression",
      entityId: entry.id,
      fromState: "active",
      toState: "active",
      reason: "suppression_provenance_upgraded",
      actor: input.actor,
      metadata: {
        previousReason: entry.reason,
        reason: input.reason,
        sourceReplyId: input.sourceReplyId,
        sourceInboundRecordId: input.sourceInboundRecordId,
      },
    });
  }
  return {
    disposition: created ? "created" : "existing",
    entry: effectiveEntry,
  };
}

export async function addSuppression(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "created" | "existing"; entry: Entry }
  | { ok: false; code: "INVALID_INPUT" | "DATABASE_ERROR" }
> {
  const parsed = addSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  let normalizedValue: string;
  try {
    normalizedValue = normalizeSuppressionTarget(
      parsed.data.scope,
      parsed.data.value,
    );
  } catch {
    return { ok: false, code: "INVALID_INPUT" };
  }
  try {
    const key =
      parsed.data.scope === "email"
        ? actionLockKey.recipient(normalizedValue)
        : actionLockKey.domain(normalizedValue);
    return await withActionLocks(db, [key], async (lockedDb) =>
      lockedDb.transaction(async (tx) => {
        const inserted = await insertSuppressionInTransaction(tx, {
          ...parsed.data,
          normalizedValue,
        });
        return { ok: true, ...inserted } as const;
      }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function removeSuppression(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "removed" | "not_found" }
  | {
      ok: false;
      code:
        "INVALID_INPUT" | "REMOVAL_REQUIRES_CONFIRMATION" | "DATABASE_ERROR";
    }
> {
  const parsed = removeSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  try {
    const [candidate] = await db
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.id, parsed.data.id))
      .limit(1);
    if (!candidate) return { ok: true, disposition: "not_found" } as const;
    const key =
      candidate.scope === "email"
        ? actionLockKey.recipient(candidate.normalizedValue)
        : actionLockKey.domain(candidate.normalizedValue);
    return await withActionLocks(db, [key], async (lockedDb) =>
      lockedDb.transaction(async (tx) => {
        const [entry] = await tx
          .select()
          .from(suppressionEntries)
          .where(eq(suppressionEntries.id, parsed.data.id))
          .limit(1);
        if (!entry) return { ok: true, disposition: "not_found" } as const;
        const allowed =
          entry.reason === "unsubscribe"
            ? parsed.data.confirmedResubscription === true
            : entry.reason === "hard_bounce"
              ? parsed.data.verifiedAddressOverride === true
              : true;
        if (
          !allowed ||
          ((entry.reason === "unsubscribe" || entry.reason === "hard_bounce") &&
            !parsed.data.justification)
        ) {
          return {
            ok: false,
            code: "REMOVAL_REQUIRES_CONFIRMATION",
          } as const;
        }
        await tx.insert(stateTransitions).values({
          entityType: "suppression",
          entityId: entry.id,
          fromState: "active",
          toState: "removed",
          reason: "operator_removed",
          actor: parsed.data.actor,
          metadata: {
            scope: entry.scope,
            normalizedValue: entry.normalizedValue,
            justification: parsed.data.justification,
            confirmedResubscription: parsed.data.confirmedResubscription,
            verifiedAddressOverride: parsed.data.verifiedAddressOverride,
          },
        });
        await tx
          .delete(suppressionEntries)
          .where(eq(suppressionEntries.id, entry.id));
        return { ok: true, disposition: "removed" } as const;
      }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function listSuppressions(
  db: AppDatabase,
  filter: { scope?: "email" | "domain" },
): Promise<Entry[]> {
  return filter.scope
    ? db
        .select()
        .from(suppressionEntries)
        .where(eq(suppressionEntries.scope, filter.scope))
        .orderBy(asc(suppressionEntries.normalizedValue))
    : db
        .select()
        .from(suppressionEntries)
        .orderBy(asc(suppressionEntries.normalizedValue));
}
