import type { AppDatabase } from "@/lib/db/types";
import type { PersonalizationAgent } from "@/modules/agents/contracts";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import {
  personalizationInputSchema,
  type PersonalizationInput,
  type PersonalizationOutput,
} from "@/modules/agents/schemas";
import { validatePersonalizationPostconditions } from "@/modules/agents/provenance";

export type PersonalizeReasoningFieldsResult =
  | { ok: true; personalization: PersonalizationOutput; agentRunId: string }
  | {
      ok: false;
      code: "INVALID_INPUT" | "AGENT_ERROR" | "DATABASE_ERROR";
      message: string;
    };

export async function personalizeReasoningFields(
  db: AppDatabase,
  agent: PersonalizationAgent,
  rawInput: PersonalizationInput,
): Promise<PersonalizeReasoningFieldsResult> {
  const parsed = personalizationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid personalization input",
    };
  }
  let runId: string;
  try {
    runId = await startAgentRun(db, agent, parsed.data);
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not start personalization",
    };
  }
  try {
    const result = await agent.personalize(parsed.data);
    validatePersonalizationPostconditions(parsed.data, result);
    await completeAgentRun(db, runId, result);
    return { ok: true, personalization: result.output, agentRunId: runId };
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "AGENT_ERROR",
      message: "Personalization failed",
    };
  }
}
