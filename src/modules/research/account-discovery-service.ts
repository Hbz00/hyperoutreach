import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { accounts, evidenceSources } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import {
  accountDiscoveryInputSchema,
  accountDiscoveryOutputSchema,
  type AccountDiscoveryInput,
  type AccountDiscoveryOutput,
} from "@/modules/agents/schemas";
import type { AccountDiscoveryAgent } from "@/modules/agents/contracts";
import { parseAccountInput } from "@/modules/accounts/input";
import { decideAccountMerge } from "@/modules/research/account-merge";
import { validateAccountDiscoveryProvenance } from "@/modules/agents/provenance";

type Account = typeof accounts.$inferSelect;
type Candidate = AccountDiscoveryOutput["candidates"][number];

export type DiscoverAccountsResult =
  | {
      ok: true;
      accounts: Account[];
      conflicts: Array<{
        code: "AMBIGUOUS_NAME";
        name: string;
        domain: string | null;
      }>;
      agentRunId: string;
    }
  | {
      ok: false;
      code: "INVALID_INPUT" | "AGENT_ERROR" | "DATABASE_ERROR";
      message: string;
    };

async function upsertCandidate(
  tx: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0],
  candidate: Candidate,
): Promise<
  | { account: Account; conflict: null }
  | {
      account: null;
      conflict: {
        code: "AMBIGUOUS_NAME";
        name: string;
        domain: string | null;
      };
    }
> {
  const input = parseAccountInput({
    name: candidate.name,
    domain: candidate.domain,
    website: candidate.website,
  });
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
  const sameNameDomain = sameNameDomains[0];
  const decision = decideAccountMerge({
    incomingDomain: input.domain,
    strongDomainAccountId: strong?.id ?? null,
    domainlessNameAccountId: fallback?.id ?? null,
    sameNameDomainAccountId: sameNameDomain?.id ?? null,
    sameNameDomainAccountCount: sameNameDomains.length,
  });
  if (decision.action === "ambiguous") {
    return {
      account: null,
      conflict: {
        code: "AMBIGUOUS_NAME",
        name: candidate.name,
        domain: input.domain,
      },
    };
  }
  if (decision.action === "use_existing") {
    const existing =
      strong?.id === decision.accountId
        ? strong
        : fallback?.id === decision.accountId
          ? fallback
          : sameNameDomain;
    if (!existing) throw new Error("Account merge target disappeared");
    const [updated] = await tx
      .update(accounts)
      .set({
        website: existing.website ?? input.website,
        industry: existing.industry ?? candidate.industry,
        employeeRange: existing.employeeRange ?? candidate.employeeRange,
        country: existing.country ?? candidate.country,
      })
      .where(eq(accounts.id, existing.id))
      .returning();
    if (!updated) throw new Error("Account update returned no row");
    return { account: updated, conflict: null };
  }
  if (decision.action === "enrich_fallback") {
    const [updated] = await tx
      .update(accounts)
      .set({
        domain: input.domain,
        website: input.website,
        industry: candidate.industry,
        employeeRange: candidate.employeeRange,
        country: candidate.country,
      })
      .where(eq(accounts.id, decision.accountId))
      .returning();
    if (!updated) throw new Error("Account enrichment returned no row");
    return { account: updated, conflict: null };
  }
  const [created] = await tx
    .insert(accounts)
    .values({
      ...input,
      industry: candidate.industry,
      employeeRange: candidate.employeeRange,
      country: candidate.country,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { account: created, conflict: null };
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
  if (!raced) throw new Error("Account conflict could not be reconciled");
  return { account: raced, conflict: null };
}

export async function discoverAccounts(
  db: AppDatabase,
  agent: AccountDiscoveryAgent,
  rawInput: AccountDiscoveryInput,
): Promise<DiscoverAccountsResult> {
  const parsed = accountDiscoveryInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid discovery input",
    };
  }
  let runId: string;
  try {
    runId = await startAgentRun(db, agent, parsed.data);
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not start discovery",
    };
  }
  let result;
  try {
    result = await agent.discover(parsed.data);
    accountDiscoveryOutputSchema.parse(result.output);
    if (result.output.candidates.length > parsed.data.limit) {
      throw new Error("Account discovery exceeded requested output limit");
    }
    validateAccountDiscoveryProvenance(result);
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "AGENT_ERROR",
      message: "Account discovery failed",
    };
  }
  try {
    const evidenceObservedAt = new Date();
    const discovered = await db.transaction(async (tx) => {
      const persisted: Account[] = [];
      const conflicts: Array<{
        code: "AMBIGUOUS_NAME";
        name: string;
        domain: string | null;
      }> = [];
      for (const candidate of result.output.candidates) {
        const outcome = await upsertCandidate(tx, candidate);
        if (outcome.conflict) {
          conflicts.push(outcome.conflict);
          continue;
        }
        const account = outcome.account;
        persisted.push(account);
        for (const source of candidate.sources) {
          await tx
            .insert(evidenceSources)
            .values({
              accountId: account.id,
              url: source.url,
              title: source.title,
              sourceType: "account_discovery",
              retrievedAt: evidenceObservedAt,
              supports: source.supports,
              confidence: candidate.confidence.toFixed(3),
              metadata: { agentRunId: runId },
            })
            .onConflictDoUpdate({
              target: [evidenceSources.accountId, evidenceSources.url],
              targetWhere: sql`${evidenceSources.accountId} is not null`,
              set: {
                title: source.title,
                sourceType: "account_discovery",
                retrievedAt: evidenceObservedAt,
                supports: source.supports,
                confidence: candidate.confidence.toFixed(3),
                metadata: { agentRunId: runId },
              },
            });
        }
      }
      await completeAgentRun(tx, runId, result);
      return { persisted, conflicts };
    });
    return {
      ok: true,
      accounts: [
        ...new Map(
          discovered.persisted.map((account) => [account.id, account]),
        ).values(),
      ],
      conflicts: discovered.conflicts,
      agentRunId: runId,
    };
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save discovery",
    };
  }
}
