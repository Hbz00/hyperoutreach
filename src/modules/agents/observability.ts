import { eq } from "drizzle-orm";

import { agentRuns } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { ObservableAgent } from "@/modules/agents/contracts";
import type { AgentResult } from "@/modules/agents/types";

type AgentRunWriter = Pick<AppDatabase, "insert" | "update">;

export async function startAgentRun(
  db: AgentRunWriter,
  agent: ObservableAgent,
  input: Record<string, unknown>,
): Promise<string> {
  const [run] = await db
    .insert(agentRuns)
    .values({
      agent: agent.name,
      model: agent.model,
      // Written here and never at completion, unlike `model`. A lane's effort
      // is a property of how the caller was configured, not of what the
      // surface reports at that instant — the desktop app answers with the
      // picker's current state, which can read `none`. One source, chosen.
      effort: agent.effort ?? null,
      promptVersion: agent.promptVersion,
      schemaVersion: agent.schemaVersion,
      input,
      status: "started",
    })
    .returning({ id: agentRuns.id });
  if (!run) throw new Error("Agent run creation returned no row");
  return run.id;
}

export async function completeAgentRun<T>(
  db: AgentRunWriter,
  runId: string,
  result: AgentResult<T>,
): Promise<void> {
  const sources = new Map<string, Record<string, unknown>>();
  for (const source of result.sources) {
    sources.set(String(source.url), source);
  }
  await db
    .update(agentRuns)
    .set({
      responseId: result.responseId,
      model: result.model,
      output: result.output as Record<string, unknown>,
      sources: [...sources.values()],
      tokenUsage: result.usage ?? null,
      toolUsage: result.toolUsage ?? null,
      costUsd: result.costUsd === null ? null : result.costUsd.toFixed(6),
      costAvailability:
        result.costAvailability ??
        (result.costUsd === null ? "unavailable" : "available"),
      status: "succeeded",
      error: null,
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}

export function sanitizedAgentFailure(error: unknown): string {
  const kind =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
      ? error.name
      : "UnknownError";
  return `Agent execution failed (${kind})`;
}

export async function failAgentRun(
  db: AgentRunWriter,
  runId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: sanitizedAgentFailure(error),
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}
