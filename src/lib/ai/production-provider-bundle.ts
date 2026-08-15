import {
  resolveAIProviderConfig,
  type ChatGptDesktopConfig,
} from "@/lib/ai/provider-config";
import {
  createLiveAIProviderBundle,
  type AIProviderBundle,
} from "@/lib/ai/provider-bundle";
import type { StructuredAIProvider } from "@/lib/ai/providers/types";
import { ChatGptDesktopStructuredAIProvider } from "@/lib/chatgpt-desktop/structured-provider";

type ProductionProviderFactories = {
  chatGptDesktop?(config: ChatGptDesktopConfig): StructuredAIProvider;
};

export function createProductionAIProviderBundle(
  environment: Record<string, string | undefined> = process.env,
  factories: ProductionProviderFactories = {},
): AIProviderBundle {
  const config = resolveAIProviderConfig(environment);
  if (config.mode === "mock") return config;

  return createLiveAIProviderBundle(config, {
    chatGptDesktop:
      factories.chatGptDesktop ??
      ((desktopConfig) =>
        new ChatGptDesktopStructuredAIProvider(desktopConfig)),
  });
}
