import "server-only";

import { createOpenAIResponsesProvider } from "@/lib/openai/client";
import { requireOpenAIConfig } from "@/lib/openai/config";
import { OpenAIReplyClassifier } from "@/modules/agents/openai-agents";
import {
  DeterministicReplyClassifier,
  type ReplyClassifier,
} from "@/modules/replies/reply-classifier";

export function createReplyClassifier(
  environment: Record<string, string | undefined> = process.env,
): ReplyClassifier {
  if (environment.OPENAI_PROVIDER === "openai") {
    const config = requireOpenAIConfig(environment);
    return new OpenAIReplyClassifier(
      createOpenAIResponsesProvider(environment),
      config.fastModel,
    );
  }
  return new DeterministicReplyClassifier();
}
