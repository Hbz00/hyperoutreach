import {
  resolveWorkflowProvider,
  type WorkflowProvider,
} from "@/modules/workflows/provider-config";

/**
 * Every AI task runs through the local ChatGPT desktop app. There is no hosted
 * API path. `mock` is the default because the live surface has side effects on
 * the operator's own machine — it launches and drives their ChatGPT app — and a
 * default should never do that without being asked.
 */
export type AIProviderMode = "mock" | "chatgpt_desktop";

/**
 * Model and effort are the labels the desktop picker shows, because that
 * picker is the only place where the choice actually exists. They are
 * validated for shape, not against a fixed list: the app publishes new names
 * on its own schedule and a stale enum here would reject a working setup.
 */
export type ChatGptDesktopLane = {
  model: string;
  effort: string;
  timeoutMs: number;
};

export type ChatGptDesktopConfig = {
  /** Web-search agents: account discovery/research, contact discovery, email evidence. */
  research: ChatGptDesktopLane;
  /** Non-web agents: personalization and reply classification. */
  fast: ChatGptDesktopLane;
};

export type ResolvedAIProviderConfig =
  | { mode: "mock"; usesRealInfrastructure: false }
  | {
      mode: "chatgpt_desktop";
      usesRealInfrastructure: true;
      chatGptDesktop: ChatGptDesktopConfig;
    };

type AIProviderEnvironment = Record<string, string | undefined>;

export const DEFAULT_RESEARCH_MODEL = "GPT-5.6 Sol";
export const DEFAULT_RESEARCH_EFFORT = "High";
export const DEFAULT_FAST_MODEL = "GPT-5.6 Sol";
export const DEFAULT_FAST_EFFORT = "Instant";

const DEFAULT_RESEARCH_TIMEOUT_MS = 600_000;
const DEFAULT_FAST_TIMEOUT_MS = 120_000;
export const MAX_AI_TIMEOUT_MS = 900_000;
const MAX_LABEL_LENGTH = 120;

export class AIProviderConfigurationError extends Error {
  override readonly name = "AIProviderConfigurationError";
}

/**
 * The desktop app runs on the operator's machine, so the workflow that drives
 * it has to run there too. A hosted worker would have no app to talk to.
 */
export function assertAIWorkflowCompatibility(
  environment: AIProviderEnvironment,
  workflowProvider: WorkflowProvider = resolveWorkflowProvider(environment),
): void {
  if (
    resolveAIProviderMode(environment) !== "mock" &&
    workflowProvider === "trigger"
  ) {
    throw new AIProviderConfigurationError(
      "AI_PROVIDER=chatgpt_desktop requires local workflow execution and cannot be used with WORKFLOW_PROVIDER=trigger",
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

function label(
  rawValue: string | undefined,
  options: { name: string; defaultValue: string },
): string {
  const value = rawValue?.trim();
  if (!value) return options.defaultValue;
  if (value.length > MAX_LABEL_LENGTH) {
    throw new AIProviderConfigurationError(
      `${options.name} must be at most ${MAX_LABEL_LENGTH} characters`,
    );
  }
  return value;
}

export function resolveAIProviderMode(
  environment: AIProviderEnvironment,
): AIProviderMode {
  const mode = environment.AI_PROVIDER?.trim() || "mock";
  if (mode !== "mock" && mode !== "chatgpt_desktop") {
    throw new AIProviderConfigurationError(
      "AI_PROVIDER must be one of: mock, chatgpt_desktop",
    );
  }
  return mode;
}

export function resolveAIProviderConfig(
  environment: AIProviderEnvironment,
): ResolvedAIProviderConfig {
  const mode = resolveAIProviderMode(environment);
  if (mode === "mock") {
    return { mode, usesRealInfrastructure: false };
  }
  assertAIWorkflowCompatibility(environment);

  return {
    mode,
    usesRealInfrastructure: true,
    chatGptDesktop: {
      research: {
        model: label(environment.AI_RESEARCH_MODEL, {
          name: "AI_RESEARCH_MODEL",
          defaultValue: DEFAULT_RESEARCH_MODEL,
        }),
        effort: label(environment.AI_RESEARCH_EFFORT, {
          name: "AI_RESEARCH_EFFORT",
          defaultValue: DEFAULT_RESEARCH_EFFORT,
        }),
        timeoutMs: boundedInteger(environment.AI_RESEARCH_TIMEOUT_MS, {
          name: "AI_RESEARCH_TIMEOUT_MS",
          defaultValue: DEFAULT_RESEARCH_TIMEOUT_MS,
          max: MAX_AI_TIMEOUT_MS,
        }),
      },
      fast: {
        model: label(environment.AI_FAST_MODEL, {
          name: "AI_FAST_MODEL",
          defaultValue: DEFAULT_FAST_MODEL,
        }),
        effort: label(environment.AI_FAST_EFFORT, {
          name: "AI_FAST_EFFORT",
          defaultValue: DEFAULT_FAST_EFFORT,
        }),
        timeoutMs: boundedInteger(environment.AI_FAST_TIMEOUT_MS, {
          name: "AI_FAST_TIMEOUT_MS",
          defaultValue: DEFAULT_FAST_TIMEOUT_MS,
          max: MAX_AI_TIMEOUT_MS,
        }),
      },
    },
  };
}
