import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { accounts, evidenceSources } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { AccountResearchAgent } from "@/modules/agents/contracts";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import { accountResearchOutputSchema } from "@/modules/agents/schemas";
import { validateAccountResearchProvenance } from "@/modules/agents/provenance";
import {
  DEFAULT_RESEARCH_TTL_MS,
  shouldReuseResearch,
} from "@/modules/research/freshness";

export type ResearchAccountResult =
  | {
      ok: true;
      disposition: "reused" | "researched" | "in_progress";
      snapshot: Record<string, unknown> | null;
      agentRunId: string | null;
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

export async function researchAccount(
  db: AppDatabase,
  agent: AccountResearchAgent,
  input: {
    accountId: string;
    force?: boolean;
    ttlMs?: number;
    now?: Date;
    claimLeaseMs?: number;
  },
): Promise<ResearchAccountResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.accountId)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid research input",
    };
  }
  const now = input.now ?? new Date();
  const claimLeaseMs = input.claimLeaseMs ?? 5 * 60_000;
  const claimId = randomUUID();
  let claim:
    | { kind: "not_found" }
    | { kind: "reused"; snapshot: Record<string, unknown> }
    | { kind: "in_progress"; snapshot: Record<string, unknown> | null }
    | {
        kind: "claimed";
        account: typeof accounts.$inferSelect;
        runId: string;
        agentInput: {
          account: { id: string; name: string; domain: string | null };
        };
      };
  try {
    claim = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from accounts where id = ${input.accountId} for update`,
      );
      const [account] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .limit(1);
      if (!account) return { kind: "not_found" } as const;
      if (
        account.researchStatus === "complete" &&
        shouldReuseResearch({
          snapshot: account.researchSnapshot,
          researchedAt: account.researchedAt,
          now,
          ttlMs: input.ttlMs ?? DEFAULT_RESEARCH_TTL_MS,
          force: input.force ?? false,
        })
      ) {
        return {
          kind: "reused",
          snapshot: account.researchSnapshot!,
        } as const;
      }
      const claimIsFresh =
        account.researchStatus === "in_progress" &&
        account.researchClaimId !== null &&
        account.researchClaimedAt !== null &&
        now.getTime() - account.researchClaimedAt.getTime() < claimLeaseMs;
      if (claimIsFresh) {
        return {
          kind: "in_progress",
          snapshot: account.researchSnapshot,
        } as const;
      }
      const agentInput = {
        account: {
          id: account.id,
          name: account.name,
          domain: account.domain,
        },
      };
      const runId = await startAgentRun(tx, agent, agentInput);
      await tx
        .update(accounts)
        .set({
          researchStatus: "in_progress",
          researchClaimId: claimId,
          researchClaimedAt: now,
        })
        .where(eq(accounts.id, account.id));
      return { kind: "claimed", account, runId, agentInput } as const;
    });
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not start research",
    };
  }
  if (claim.kind === "not_found") {
    return {
      ok: false,
      code: "ACCOUNT_NOT_FOUND",
      message: "Account not found",
    };
  }
  if (claim.kind === "reused" || claim.kind === "in_progress") {
    return {
      ok: true,
      disposition: claim.kind,
      snapshot: claim.snapshot,
      agentRunId: null,
    };
  }
  const { account, agentInput, runId } = claim;
  let result;
  try {
    result = await agent.research(agentInput);
    accountResearchOutputSchema.parse(result.output);
    validateAccountResearchProvenance(result);
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    await db
      .update(accounts)
      .set({
        researchStatus: "failed",
        researchClaimId: null,
        researchClaimedAt: null,
      })
      .where(
        and(eq(accounts.id, account.id), eq(accounts.researchClaimId, claimId)),
      )
      .catch(() => undefined);
    return {
      ok: false,
      code: "AGENT_ERROR",
      message: "Account research failed",
    };
  }
  try {
    const snapshot = result.output as Record<string, unknown>;
    const evidenceObservedAt = new Date();
    const persistedByOwner = await db.transaction(async (tx) => {
      const [ownedUpdate] = await tx
        .update(accounts)
        .set({
          researchStatus: "complete",
          researchSnapshot: snapshot,
          researchedAt: now,
          researchClaimId: null,
          researchClaimedAt: null,
          website: result.output.facts.website ?? account.website,
          industry: result.output.facts.industry ?? account.industry,
          employeeRange:
            result.output.facts.employeeRange ?? account.employeeRange,
          country: result.output.facts.country ?? account.country,
        })
        .where(
          and(
            eq(accounts.id, account.id),
            eq(accounts.researchClaimId, claimId),
          ),
        )
        .returning({ id: accounts.id });
      if (ownedUpdate) {
        for (const source of result.output.sources) {
          await tx
            .insert(evidenceSources)
            .values({
              accountId: account.id,
              url: source.url,
              title: source.title,
              sourceType: "account_research",
              retrievedAt: evidenceObservedAt,
              supports: source.supports,
              confidence: result.output.confidence.toFixed(3),
              metadata: { agentRunId: runId },
            })
            .onConflictDoUpdate({
              target: [evidenceSources.accountId, evidenceSources.url],
              targetWhere: sql`${evidenceSources.accountId} is not null`,
              set: {
                title: source.title,
                sourceType: "account_research",
                retrievedAt: evidenceObservedAt,
                supports: source.supports,
                confidence: result.output.confidence.toFixed(3),
                metadata: { agentRunId: runId },
              },
            });
        }
      }
      await completeAgentRun(tx, runId, result);
      return Boolean(ownedUpdate);
    });
    if (!persistedByOwner) {
      const [stored] = await db
        .select({
          researchStatus: accounts.researchStatus,
          researchSnapshot: accounts.researchSnapshot,
        })
        .from(accounts)
        .where(eq(accounts.id, account.id))
        .limit(1);
      return {
        ok: true,
        disposition:
          stored?.researchStatus === "in_progress" ? "in_progress" : "reused",
        snapshot: stored?.researchSnapshot ?? null,
        agentRunId: runId,
      };
    }
    const [stored] = await db
      .select({
        researchSnapshot: accounts.researchSnapshot,
        researchClaimId: accounts.researchClaimId,
      })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .limit(1);
    if (stored?.researchClaimId && stored.researchClaimId !== claimId) {
      return {
        ok: true,
        disposition: "in_progress",
        snapshot: stored.researchSnapshot,
        agentRunId: null,
      };
    }
    return {
      ok: true,
      disposition: "researched",
      snapshot,
      agentRunId: runId,
    };
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    await db
      .update(accounts)
      .set({
        researchStatus: "failed",
        researchClaimId: null,
        researchClaimedAt: null,
      })
      .where(
        and(eq(accounts.id, account.id), eq(accounts.researchClaimId, claimId)),
      )
      .catch(() => undefined);
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save research",
    };
  }
}
