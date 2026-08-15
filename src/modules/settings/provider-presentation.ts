import {
  AIProviderConfigurationError,
  resolveAIProviderConfig,
  type ResolvedAIProviderConfig,
} from "@/lib/ai/provider-config";
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
  sourceProvenanceNote?: string;
  configurationNotice?: string;
};

type ProviderConfigResolver = (
  environment: Record<string, string | undefined>,
) => ResolvedAIProviderConfig;

function lane(model: string, effort: string): string {
  return `${model} · ${effort}`;
}

export function getProviderPresentation(
  config: ResolvedAIProviderConfig,
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
    };
  }

  const { research, fast } = config.chatGptDesktop;
  return {
    provider: "Local ChatGPT desktop app",
    researchModel: lane(research.model, research.effort),
    nonWebModel: lane(fast.model, fast.effort),
    workflowProvider: workflowProviderLabel,
    sourceProvenanceNote:
      "Web citations are model-declared: the desktop app reports neither its searches nor its token usage.",
  };
}

export async function resolveProviderPresentation(
  environment: Record<string, string | undefined>,
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
      configurationNotice:
        "Provider configuration is invalid. Check the server environment.",
    };
  }

  return getProviderPresentation(config, workflowProvider);
}
