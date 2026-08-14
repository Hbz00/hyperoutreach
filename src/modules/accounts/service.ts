import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { accounts } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { parseAccountInput } from "@/modules/accounts/input";
import { decideAccountMerge } from "@/modules/research/account-merge";

type Account = typeof accounts.$inferSelect;

export type CreateAccountResult =
  | { ok: true; disposition: "created" | "existing"; account: Account }
  | { ok: false; code: "INVALID_INPUT"; message: "Invalid account input" }
  | {
      ok: false;
      code: "AMBIGUOUS_IDENTITY";
      message: "Company name matches multiple domains; provide a domain";
    }
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`account-name:${input.normalizedName}`}, 0))`,
      );
      const [strong] = input.domain
        ? await tx
            .select()
            .from(accounts)
            .where(eq(accounts.domain, input.domain))
            .limit(1)
        : [];
      const [fallback] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.normalizedName, input.normalizedName),
            isNull(accounts.domain),
          ),
        )
        .limit(1)
        .for("update");
      const sameNameDomains = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.normalizedName, input.normalizedName),
            isNotNull(accounts.domain),
          ),
        )
        .orderBy(accounts.createdAt, accounts.id)
        .for("update");
      const decision = decideAccountMerge({
        incomingDomain: input.domain,
        strongDomainAccountId: strong?.id ?? null,
        domainlessNameAccountId: fallback?.id ?? null,
        sameNameDomainAccountId: sameNameDomains[0]?.id ?? null,
        sameNameDomainAccountCount: sameNameDomains.length,
      });
      if (decision.action === "ambiguous") {
        return {
          ok: false,
          code: "AMBIGUOUS_IDENTITY",
          message: "Company name matches multiple domains; provide a domain",
        } as const;
      }
      if (decision.action === "use_existing") {
        const existing =
          strong?.id === decision.accountId
            ? strong
            : fallback?.id === decision.accountId
              ? fallback
              : sameNameDomains.find(
                  (account) => account.id === decision.accountId,
                );
        if (!existing) throw new Error("Account merge target disappeared");
        return {
          ok: true,
          disposition: "existing",
          account: existing,
        } as const;
      }
      if (decision.action === "enrich_fallback") {
        const [enriched] = await tx
          .update(accounts)
          .set({ domain: input.domain, website: input.website })
          .where(eq(accounts.id, decision.accountId))
          .returning();
        if (!enriched) throw new Error("Account enrichment returned no row");
        return {
          ok: true,
          disposition: "existing",
          account: enriched,
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

      const [raced] = input.domain
        ? await tx
            .select()
            .from(accounts)
            .where(eq(accounts.domain, input.domain))
            .limit(1)
        : await tx
            .select()
            .from(accounts)
            .where(
              and(
                eq(accounts.normalizedName, input.normalizedName),
                isNull(accounts.domain),
              ),
            )
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
