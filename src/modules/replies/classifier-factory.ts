import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import type { AIProviderBundle } from "@/lib/ai/provider-bundle";
import { StructuredReplyClassifier } from "@/modules/agents/structured-agents";
import {
  DeterministicReplyClassifier,
  type ReplyClassifier,
} from "@/modules/replies/reply-classifier";

export function createReplyClassifierFromBundle(
  bundle: AIProviderBundle,
): ReplyClassifier {
  if (bundle.usesRealInfrastructure) {
    return new StructuredReplyClassifier(
      bundle.nonWeb.provider,
      bundle.nonWeb.model,
      "chatgpt-desktop-reply-v1",
      bundle.nonWeb.effort,
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
