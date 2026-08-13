import type { CodexCliStatus } from "@/lib/codex/status";
import {
  AIProviderConfigurationError,
  resolveAIProviderConfig,
  type ResolvedAIProviderConfig,
} from "@/lib/openai/provider-config";
import {
  resolveWorkflowProvider,
  WorkflowProviderConfigurationError,
  type WorkflowProvider,
} from "@/modules/workflows/provider-config";

export type ProviderPresentation = {
  provider: string;
  researchModel: string;
  nonWebModel: string;
  workflowProvider: string;
  codexStatus: string | undefined;
  codexStatusNote?: string;
  sourceProvenanceNote?: string;
  configurationNotice?: string;
};

type ProviderConfigResolver = (
  environment: Record<string, string | undefined>,
) => ResolvedAIProviderConfig;

const CODEX_STATUS_LABELS: Record<CodexCliStatus, string> = {
  authenticated: "Authenticated",
  not_authenticated: "Installed, not authenticated",
  unavailable: "Unavailable",
};

export function getProviderPresentation(
  config: ResolvedAIProviderConfig,
  codexStatus?: CodexCliStatus,
  workflowProvider: WorkflowProvider = "local",
): ProviderPresentation {
  const workflowProviderLabel =
    workflowProvider === "trigger" ? "Trigger.dev" : "Local";
  if (config.mode === "mock") {
    return {
      provider: "Deterministic mock",
      researchModel: "deterministic-mock",
      nonWebModel: "deterministic-mock",
      workflowProvider: workflowProviderLabel,
      codexStatus: undefined,
    };
  }

  if (config.mode === "openai") {
    return {
      provider: "OpenAI Responses API",
      researchModel: config.openai.researchModel,
      nonWebModel: config.openai.fastModel,
      workflowProvider: workflowProviderLabel,
      codexStatus: undefined,
    };
  }

  return {
    provider: "Local Codex CLI / ChatGPT account for all AI tasks",
    researchModel: config.codex.researchModel,
    nonWebModel: config.codex.fastModel,
    workflowProvider: workflowProviderLabel,
    codexStatus: CODEX_STATUS_LABELS[codexStatus ?? "unavailable"],
    codexStatusNote:
      "Login status only; hardened Codex invocations can still fail closed if the installed CLI is incompatible.",
    sourceProvenanceNote:
      "Web citations are model-declared after an observed Codex search, not tool-observed.",
  };
}

export async function statusForProvider(
  config: ResolvedAIProviderConfig,
  statusLoader: (executable: string) => Promise<CodexCliStatus>,
): Promise<CodexCliStatus | undefined> {
  if (config.mode !== "codex") return undefined;
  return statusLoader(config.codex.executable);
}

export async function resolveProviderPresentation(
  environment: Record<string, string | undefined>,
  statusLoader: (executable: string) => Promise<CodexCliStatus>,
  configResolver: ProviderConfigResolver = resolveAIProviderConfig,
): Promise<ProviderPresentation> {
  let config: ResolvedAIProviderConfig;
  let workflowProvider: WorkflowProvider;
  try {
    workflowProvider = resolveWorkflowProvider(environment);
    config = configResolver(environment);
  } catch (error) {
    if (
      !(error instanceof AIProviderConfigurationError) &&
      !(error instanceof WorkflowProviderConfigurationError)
    ) {
      throw error;
    }
    return {
      provider: "Misconfigured",
      researchModel: "Unavailable",
      nonWebModel: "Unavailable",
      workflowProvider: "Misconfigured",
      codexStatus: undefined,
      configurationNotice:
        "Provider configuration is invalid. Check the server environment.",
    };
  }

  const codexStatus = await statusForProvider(config, statusLoader);
  return getProviderPresentation(config, codexStatus, workflowProvider);
}
