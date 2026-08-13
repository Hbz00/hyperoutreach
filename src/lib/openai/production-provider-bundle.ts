import { CodexCliStructuredAIProvider } from "@/lib/codex/structured-provider";
import { createOpenAIResponsesProviderFromConfig } from "@/lib/openai/client";
import {
  createLiveAIProviderBundle,
  type AIProviderBundle,
} from "@/lib/openai/provider-bundle";
import {
  resolveAIProviderConfig,
  type CodexConfig,
  type OpenAIConfig,
} from "@/lib/openai/provider-config";
import type { StructuredAIProvider } from "@/lib/openai/providers/types";

type ProductionProviderFactories = {
  openAI?(config: OpenAIConfig): StructuredAIProvider;
  codex?(config: CodexConfig): StructuredAIProvider;
};

export function createProductionAIProviderBundle(
  environment: Record<string, string | undefined> = process.env,
  factories: ProductionProviderFactories = {},
): AIProviderBundle {
  const config = resolveAIProviderConfig(environment);
  if (config.mode === "mock") return config;

  if (config.mode === "codex") {
    return createLiveAIProviderBundle(config, {
      codex:
        factories.codex ??
        ((codexConfig) => new CodexCliStructuredAIProvider(codexConfig)),
    });
  }

  return createLiveAIProviderBundle(config, {
    responses:
      factories.openAI ??
      ((openaiConfig) => createOpenAIResponsesProviderFromConfig(openaiConfig)),
  });
}
