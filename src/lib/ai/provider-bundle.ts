import {
  AIProviderConfigurationError,
  type ChatGptDesktopConfig,
  type ResolvedAIProviderConfig,
} from "@/lib/ai/provider-config";
import type { StructuredAIProvider } from "@/lib/ai/providers/types";

/**
 * The two lanes every AI consumer picks from. `research` is web-capable and
 * slow; `nonWeb` is neither. Consumers depend on this shape, never on which
 * surface executes the call.
 */
export type LiveAIProviderBundle = {
  mode: "chatgpt_desktop";
  usesRealInfrastructure: true;
  research: {
    provider: StructuredAIProvider;
    model: string;
    effort: string;
    operationTimeoutMs: number;
  };
  nonWeb: { provider: StructuredAIProvider; model: string; effort: string };
};

export type AIProviderBundle =
  { mode: "mock"; usesRealInfrastructure: false } | LiveAIProviderBundle;

type LiveAIProviderConfig = Exclude<ResolvedAIProviderConfig, { mode: "mock" }>;

type ProviderFactories = {
  chatGptDesktop?(config: ChatGptDesktopConfig): StructuredAIProvider;
};

/** Audit model identifiers carry their surface, so a run is attributable. */
export const CHATGPT_DESKTOP_MODEL_PREFIX = "chatgpt-desktop:";

export function auditModel(model: string): string {
  return `${CHATGPT_DESKTOP_MODEL_PREFIX}${model}`;
}

export function createLiveAIProviderBundle(
  config: LiveAIProviderConfig,
  factories: ProviderFactories,
): LiveAIProviderBundle {
  if (!factories.chatGptDesktop) {
    throw new AIProviderConfigurationError(
      "A ChatGPT desktop provider factory is required",
    );
  }
  const provider = factories.chatGptDesktop(config.chatGptDesktop);
  return {
    mode: config.mode,
    usesRealInfrastructure: true,
    research: {
      provider,
      model: auditModel(config.chatGptDesktop.research.model),
      // Carried beside the model rather than folded into it: both lanes run
      // the same model, so the effort is the only thing that tells a
      // ten-minute web-capable turn from a two-minute one.
      effort: config.chatGptDesktop.research.effort,
      operationTimeoutMs: config.chatGptDesktop.research.timeoutMs,
    },
    nonWeb: {
      provider,
      model: auditModel(config.chatGptDesktop.fast.model),
      effort: config.chatGptDesktop.fast.effort,
    },
  };
}
