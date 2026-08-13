import { createProductionAIProviderBundle } from "@/lib/openai/production-provider-bundle";
import type { AIProviderBundle } from "@/lib/openai/provider-bundle";
import { OpenAIReplyClassifier } from "@/modules/agents/openai-agents";
import {
  DeterministicReplyClassifier,
  type ReplyClassifier,
} from "@/modules/replies/reply-classifier";

export function createReplyClassifierFromBundle(
  bundle: AIProviderBundle,
): ReplyClassifier {
  if (bundle.usesRealInfrastructure) {
    return new OpenAIReplyClassifier(
      bundle.nonWeb.provider,
      bundle.nonWeb.model,
      bundle.mode === "codex" ? "codex-cli-reply-v1" : undefined,
    );
  }
  return new DeterministicReplyClassifier();
}

export function createReplyClassifier(
  environment: Record<string, string | undefined> = process.env,
): ReplyClassifier {
  return createReplyClassifierFromBundle(
    createProductionAIProviderBundle(environment),
  );
}
