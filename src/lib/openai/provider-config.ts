import {
  DEFAULT_OPENAI_FAST_MODEL,
  DEFAULT_OPENAI_RESEARCH_MODEL,
} from "@/lib/openai/config";
import {
  resolveWorkflowProvider,
  type WorkflowProvider,
} from "@/modules/workflows/provider-config";

export type AIProviderMode = "mock" | "openai" | "codex";

export type OpenAIConfig = {
  apiKey: string;
  researchModel: string;
  fastModel: string;
};

export type CodexConfig = {
  executable: string;
  researchModel: string;
  fastModel: string;
  timeoutMs: number;
  maxConcurrency: number;
};

export type ResolvedAIProviderConfig =
  | { mode: "mock"; usesRealInfrastructure: false }
  | {
      mode: "openai";
      usesRealInfrastructure: true;
      openai: OpenAIConfig;
    }
  | {
      mode: "codex";
      usesRealInfrastructure: true;
      codex: CodexConfig;
    };

type AIProviderEnvironment = Record<string, string | undefined>;

const DEFAULT_CODEX_TIMEOUT_MS = 240_000;
const MAX_CODEX_TIMEOUT_MS = 600_000;
const DEFAULT_CODEX_MAX_CONCURRENCY = 1;
const MAX_CODEX_MAX_CONCURRENCY = 8;

export class AIProviderConfigurationError extends Error {
  override readonly name = "AIProviderConfigurationError";
}

export function assertAIWorkflowCompatibility(
  environment: AIProviderEnvironment,
  workflowProvider: WorkflowProvider = resolveWorkflowProvider(environment),
): void {
  if (
    environment.OPENAI_PROVIDER?.trim() === "codex" &&
    workflowProvider === "trigger"
  ) {
    throw new AIProviderConfigurationError(
      "OPENAI_PROVIDER=codex requires local workflow execution and cannot be used with WORKFLOW_PROVIDER=trigger",
    );
  }
}

function boundedInteger(
  rawValue: string | undefined,
  options: { name: string; defaultValue: number; max: number },
): number {
  const value = rawValue?.trim();
  if (!value) return options.defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.max) {
    throw new AIProviderConfigurationError(
      `${options.name} must be an integer between 1 and ${options.max}`,
    );
  }
  return parsed;
}

function openAIConfig(environment: AIProviderEnvironment): OpenAIConfig {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new AIProviderConfigurationError(
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

export function resolveAIProviderConfig(
  environment: AIProviderEnvironment,
): ResolvedAIProviderConfig {
  const rawMode = environment.OPENAI_PROVIDER?.trim();
  const mode = rawMode || "mock";
  if (mode === "mock") {
    return { mode, usesRealInfrastructure: false };
  }
  if (mode !== "openai" && mode !== "codex") {
    throw new AIProviderConfigurationError(
      "OPENAI_PROVIDER must be one of: mock, openai, codex",
    );
  }
  assertAIWorkflowCompatibility(environment);

  if (mode === "openai") {
    return {
      mode,
      usesRealInfrastructure: true,
      openai: openAIConfig(environment),
    };
  }

  return {
    mode,
    usesRealInfrastructure: true,
    codex: {
      executable: environment.CODEX_EXECUTABLE?.trim() || "codex",
      researchModel:
        environment.CODEX_RESEARCH_MODEL?.trim() ||
        environment.OPENAI_RESEARCH_MODEL?.trim() ||
        DEFAULT_OPENAI_RESEARCH_MODEL,
      fastModel:
        environment.CODEX_FAST_MODEL?.trim() ||
        environment.OPENAI_FAST_MODEL?.trim() ||
        DEFAULT_OPENAI_FAST_MODEL,
      timeoutMs: boundedInteger(environment.CODEX_TIMEOUT_MS, {
        name: "CODEX_TIMEOUT_MS",
        defaultValue: DEFAULT_CODEX_TIMEOUT_MS,
        max: MAX_CODEX_TIMEOUT_MS,
      }),
      maxConcurrency: boundedInteger(environment.CODEX_MAX_CONCURRENCY, {
        name: "CODEX_MAX_CONCURRENCY",
        defaultValue: DEFAULT_CODEX_MAX_CONCURRENCY,
        max: MAX_CODEX_MAX_CONCURRENCY,
      }),
    },
  };
}
