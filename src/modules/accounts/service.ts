import { and, eq, isNull } from "drizzle-orm";

import { accounts } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  parseAccountInput,
  resolveAccountIdentity,
} from "@/modules/accounts/input";

type Account = typeof accounts.$inferSelect;

export type CreateAccountResult =
  | { ok: true; disposition: "created" | "existing"; account: Account }
  | { ok: false; code: "INVALID_INPUT"; message: "Invalid account input" }
  | { ok: false; code: "DATABASE_ERROR"; message: "Could not save account" };

export async function createOrGetAccount(
  db: AppDatabase,
  rawInput: unknown,
): Promise<CreateAccountResult> {
  let input;
  try {
    input = parseAccountInput(rawInput);
  } catch {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid account input",
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const identity = resolveAccountIdentity(input);
      const predicate =
        identity.kind === "domain"
          ? eq(accounts.domain, identity.value)
          : and(
              eq(accounts.normalizedName, identity.value),
              isNull(accounts.domain),
            );
      const [existing] = await tx
        .select()
        .from(accounts)
        .where(predicate)
        .limit(1);
      if (existing) {
        return {
          ok: true,
          disposition: "existing",
          account: existing,
        } as const;
      }

      const [created] = await tx
        .insert(accounts)
        .values(input)
        .onConflictDoNothing()
        .returning();
      if (created) {
        return { ok: true, disposition: "created", account: created } as const;
      }

      const [raced] = await tx
        .select()
        .from(accounts)
        .where(predicate)
        .limit(1);
      if (!raced) {
        throw new Error("Account conflict could not be reconciled");
      }
      return { ok: true, disposition: "existing", account: raced } as const;
    });
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save account",
    };
  }
}
