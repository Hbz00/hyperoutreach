export type WorkflowProvider = "local" | "trigger";

type WorkflowProviderEnvironment = Record<string, string | undefined>;

export class WorkflowProviderConfigurationError extends Error {
  override readonly name = "WorkflowProviderConfigurationError";
}

export function resolveWorkflowProvider(
  environment: WorkflowProviderEnvironment,
): WorkflowProvider {
  const configured = environment.WORKFLOW_PROVIDER?.trim();
  if (!configured || configured === "local" || configured === "mock") {
    return "local";
  }
  if (configured === "trigger") return configured;
  throw new WorkflowProviderConfigurationError(
    "WORKFLOW_PROVIDER must be one of: local, mock, trigger",
  );
}
