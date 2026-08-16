import { z } from "zod";

import type { AppDatabase } from "@/lib/db/types";
import type { ObservableAgent } from "@/modules/agents/contracts";
import type { AgentResult } from "@/modules/agents/types";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import type {
  ReplyClassification,
  ReplyClassifier,
  ReplyClassifierInput,
} from "@/modules/replies/reply-classifier";

export interface ObservedReplyClassifier
  extends ReplyClassifier, ObservableAgent {
  classifyObserved(
    input: ReplyClassifierInput,
  ): Promise<AgentResult<ReplyClassification>>;
}

export function isObservedReplyClassifier(
  classifier: ReplyClassifier,
): classifier is ObservedReplyClassifier {
  return (
    "classifyObserved" in classifier &&
    typeof classifier.classifyObserved === "function" &&
    "model" in classifier &&
    typeof classifier.model === "string" &&
    "promptVersion" in classifier &&
    typeof classifier.promptVersion === "string" &&
    "schemaVersion" in classifier &&
    typeof classifier.schemaVersion === "string"
  );
}

const inputSchema = z
  .object({
    subject: z.string().max(2_000),
    body: z.string().max(500_000),
    sender: z.string().trim().min(1).max(320),
  })
  .strict();

export type ClassifyReplyWithAuditResult =
  | { ok: true; classification: ReplyClassification; agentRunId: string }
  | {
      ok: false;
      code: "INVALID_INPUT" | "CLASSIFIER_ERROR" | "DATABASE_ERROR";
      message: string;
    };

export async function classifyReplyWithAudit(
  db: AppDatabase,
  classifier: ObservedReplyClassifier,
  rawInput: unknown,
): Promise<ClassifyReplyWithAuditResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Invalid reply input" };
  }
  const descriptor = {
    name: "reply_classifier",
    model: classifier.model,
    // Same reason as the inbound path this mirrors: a hand-built descriptor
    // that drops the effort records `null` on a transport where the model
    // alone cannot tell one lane from the other.
    effort: classifier.effort,
    promptVersion: classifier.promptVersion,
    schemaVersion: classifier.schemaVersion,
  };
  let runId: string;
  try {
    runId = await startAgentRun(db, descriptor, parsed.data);
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not start classification",
    };
  }
  try {
    const result = await classifier.classifyObserved(parsed.data);
    await completeAgentRun(db, runId, result);
    return { ok: true, classification: result.output, agentRunId: runId };
  } catch (error) {
    await failAgentRun(db, runId, error).catch(() => undefined);
    return {
      ok: false,
      code: "CLASSIFIER_ERROR",
      message: "Reply classification failed",
    };
  }
}
