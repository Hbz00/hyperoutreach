import {
  AIProviderConfigurationError,
  type CodexConfig,
  type OpenAIConfig,
  type ResolvedAIProviderConfig,
} from "@/lib/openai/provider-config";
import type { StructuredAIProvider } from "@/lib/openai/providers/types";
import { DEFAULT_OPENAI_OPERATION_TIMEOUT_MS } from "@/lib/openai/providers/responses-provider";

export type LiveAIProviderBundle = {
  mode: "openai" | "codex";
  usesRealInfrastructure: true;
  research: {
    provider: StructuredAIProvider;
    model: string;
    operationTimeoutMs: number;
  };
  nonWeb: { provider: StructuredAIProvider; model: string };
};

export type AIProviderBundle =
  { mode: "mock"; usesRealInfrastructure: false } | LiveAIProviderBundle;

type LiveAIProviderConfig = Exclude<ResolvedAIProviderConfig, { mode: "mock" }>;

type ProviderFactories = {
  responses?(openai: OpenAIConfig): StructuredAIProvider;
  codex?(codex: CodexConfig): StructuredAIProvider;
};

export function createLiveAIProviderBundle(
  config: LiveAIProviderConfig,
  factories: ProviderFactories,
): LiveAIProviderBundle {
  if (config.mode === "codex") {
    if (!factories.codex) {
      throw new AIProviderConfigurationError(
        "A Codex provider factory is required in Codex mode",
      );
    }
    const codex = factories.codex(config.codex);
    return {
      mode: config.mode,
      usesRealInfrastructure: true,
      research: {
        provider: codex,
        model: `codex-cli:${config.codex.researchModel}`,
        operationTimeoutMs: config.codex.timeoutMs,
      },
      nonWeb: {
        provider: codex,
        model: `codex-cli:${config.codex.fastModel}`,
      },
    };
  }

  if (!factories.responses) {
    throw new AIProviderConfigurationError(
      "A Responses provider factory is required in OpenAI mode",
    );
  }
  const responses = factories.responses(config.openai);
  return {
    mode: config.mode,
    usesRealInfrastructure: true,
    research: {
      provider: responses,
      model: config.openai.researchModel,
      operationTimeoutMs: DEFAULT_OPENAI_OPERATION_TIMEOUT_MS,
    },
    nonWeb: { provider: responses, model: config.openai.fastModel },
  };
}
