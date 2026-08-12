import { eq } from "drizzle-orm";
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
