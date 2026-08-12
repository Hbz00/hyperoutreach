export const DEFAULT_OPENAI_RESEARCH_MODEL = "gpt-5.6-terra";
export const DEFAULT_OPENAI_FAST_MODEL = "gpt-5.6-luna";

type OpenAIEnvironment = Record<string, string | undefined>;

export class OpenAIConfigurationError extends Error {
  override readonly name = "OpenAIConfigurationError";
}

export function requireOpenAIConfig(environment: OpenAIEnvironment): {
  apiKey: string;
  researchModel: string;
  fastModel: string;
} {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenAIConfigurationError(
      "OPENAI_API_KEY is required when OPENAI_PROVIDER=openai",
    );
  }
  return {
    apiKey,
    researchModel:
      environment.OPENAI_RESEARCH_MODEL?.trim() ||
      DEFAULT_OPENAI_RESEARCH_MODEL,
    fastModel:
      environment.OPENAI_FAST_MODEL?.trim() || DEFAULT_OPENAI_FAST_MODEL,
  };
}
