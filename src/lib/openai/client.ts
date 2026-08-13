import OpenAI from "openai";

import { requireOpenAIConfig } from "@/lib/openai/config";
import type { OpenAIConfig } from "@/lib/openai/provider-config";
import {
  OpenAIResponsesProvider,
  type ResponsesClient,
} from "@/lib/openai/providers/responses-provider";

export function createOpenAIResponsesProvider(
  environment: Record<string, string | undefined> = process.env,
): OpenAIResponsesProvider {
  const config = requireOpenAIConfig(environment);
  return createOpenAIResponsesProviderFromConfig(config);
}

export function createOpenAIResponsesProviderFromConfig(
  config: OpenAIConfig,
): OpenAIResponsesProvider {
  const client = new OpenAI({ apiKey: config.apiKey });
  return new OpenAIResponsesProvider(client as unknown as ResponsesClient);
}
