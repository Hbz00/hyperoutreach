import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import { mailboxConnections, stateTransitions } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";

const inputSchema = z.object({
  mailboxId: z.uuid(),
  status: z.enum([
    "pending",
    "available",
    "degraded",
    "disconnected",
    "revoked",
  ]),
  actor: z.string().trim().min(1).max(200),
});

export async function updateMailboxStatus(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "updated" | "unchanged" }
  | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" | "DATABASE_ERROR" }
> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  try {
    return await withActionLocks(
      db,
      [actionLockKey.mailbox(parsed.data.mailboxId)],
      async (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(mailboxConnections)
            .where(eq(mailboxConnections.id, parsed.data.mailboxId))
            .limit(1);
          if (!current) return { ok: false, code: "NOT_FOUND" } as const;
          if (current.status === parsed.data.status) {
            return { ok: true, disposition: "unchanged" } as const;
          }
          await tx
            .update(mailboxConnections)
            .set({ status: parsed.data.status })
            .where(eq(mailboxConnections.id, current.id));
          await tx.insert(stateTransitions).values({
            entityType: "mailbox",
            entityId: current.id,
            fromState: current.status,
            toState: parsed.data.status,
            reason: "mailbox_status_updated",
            actor: parsed.data.actor,
          });
          return { ok: true, disposition: "updated" } as const;
        }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

/**
 * Marks a mailbox `revoked` after a *definite* SMTP authentication failure
 * (`EAUTH`) — closes the design doc's §8 requirement that auth failures
 * "passent la boîte en `unavailable`" and are "pas réessayés en boucle".
 * Without this, a wrong stored SMTP password has no mailbox-level
 * consequence at all: `send-service.ts`'s existing_claim release (this same
 * task, round 1) keeps making the affected message reclaimable on every
 * recovery tick, and — because auth precedes `MAIL FROM` — every one of
 * those reclaims immediately re-attempts a full SMTP login against the
 * real server, unbounded except by the cron cadence. That is exactly the
 * failure mode repeated authentication lockouts exist to punish; this
 * function is what makes the loop stop *before* the next connection
 * instead of merely slowing it down.
 *
 * Deliberately **not** wrapped in `withActionLocks`: this is called from
 * inside `send-service.ts`'s own already-locked mailbox action (the
 * `actionLockKey.mailbox(...)` key is already held by that caller's own
 * `withActionLocks`), so acquiring the same advisory lock again from the
 * same reserved session would be redundant at best. Safety instead comes
 * from the `WHERE status = 'available'` clause below — the exact pattern
 * `microsoft-oauth-service.ts`'s own auto-revoke-on-invalid-grant
 * transition uses, for the same reason: the `UPDATE` only ever matches (and
 * only ever writes an audit row) when it actually changed something, so two
 * racing callers can never produce two transitions or a corrupted
 * `fromState`.
 *
 * Only ever transitions **from** `available` — a mailbox an operator
 * already disconnected, or one already `revoked`/`degraded`/`pending`, is
 * left exactly as it is. This is a narrow safety net for a mailbox that
 * looks healthy but has a wrong stored password, not a general-purpose
 * status setter (`updateMailboxStatus` above is that, for operator-driven
 * changes).
 */
export async function markMailboxAuthenticationFailed(
  db: AppDatabase,
  mailboxId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(mailboxConnections)
      .set({ status: "revoked" })
      .where(
        and(
          eq(mailboxConnections.id, mailboxId),
          eq(mailboxConnections.status, "available"),
        ),
      )
      .returning({ id: mailboxConnections.id });
    if (!revoked) return;
    await tx.insert(stateTransitions).values({
      entityType: "mailbox",
      entityId: mailboxId,
      fromState: "available",
      toState: "revoked",
      reason,
      actor: "system",
    });
  });
}
