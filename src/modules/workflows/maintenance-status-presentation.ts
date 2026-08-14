import { resolveAIProviderConfig } from "@/lib/openai/provider-config";
import {
  resolveWorkflowProvider,
  type WorkflowProvider,
} from "@/modules/workflows/provider-config";
import type { MaintenanceStatus } from "@/modules/workflows/maintenance-status";

const DEFAULT_CODEX_TIMEOUT_MS = 240_000;

export type MaintenanceAutomationPresentation = {
  provider: string;
  mode: string;
};

const STATUS_PRESENTATION: Record<
  MaintenanceStatus,
  { label: string; detail: string }
> = {
  not_started: {
    label: "Not started",
    detail: "No maintenance cycle has been recorded for this installation yet.",
  },
  running: {
    label: "Running",
    detail:
      "An ordered maintenance cycle is active and its database heartbeat is current.",
  },
  stalled: {
    label: "Stalled",
    detail:
      "A cycle still owns the maintenance lease, but its database heartbeat is stale.",
  },
  failed: {
    label: "Failed",
    detail:
      "The latest completed maintenance cycle failed; the next scheduled cycle will retry.",
  },
  overdue: {
    label: "Overdue",
    detail:
      "No cycle is active and the latest successful cycle is outside the expected window.",
  },
  healthy: {
    label: "Healthy",
    detail:
      "The latest ordered maintenance cycle completed within the expected window.",
  },
};

export function getMaintenanceStatusPresentation(state: MaintenanceStatus): {
  label: string;
  detail: string;
} {
  return STATUS_PRESENTATION[state];
}

export function getMaintenanceAutomationPresentation(input: {
  workflowProvider: WorkflowProvider | "misconfigured";
  localMaintenanceEnabled: boolean;
}): MaintenanceAutomationPresentation {
  if (input.workflowProvider === "misconfigured") {
    return { provider: "Misconfigured", mode: "Unavailable" };
  }
  if (input.workflowProvider === "trigger") {
    return { provider: "Trigger.dev", mode: "Scheduled aggregate cycle" };
  }
  return {
    provider: "Local",
    mode: input.localMaintenanceEnabled
      ? "Automatic worker"
      : "Disabled by configuration",
  };
}

export function resolveMaintenanceAutomationPresentation(
  environment: Record<string, string | undefined>,
): MaintenanceAutomationPresentation {
  try {
    return getMaintenanceAutomationPresentation({
      workflowProvider: resolveWorkflowProvider(environment),
      localMaintenanceEnabled:
        environment.LOCAL_MAINTENANCE_ENABLED?.trim().toLowerCase() !== "false",
    });
  } catch {
    return getMaintenanceAutomationPresentation({
      workflowProvider: "misconfigured",
      localMaintenanceEnabled: false,
    });
  }
}

export function getMaintenanceCodeTimeoutMs(
  environment: Record<string, string | undefined>,
): number {
  try {
    const config = resolveAIProviderConfig({
      OPENAI_PROVIDER: "codex",
      WORKFLOW_PROVIDER: "local",
      CODEX_TIMEOUT_MS: environment.CODEX_TIMEOUT_MS,
    });
    return config.mode === "codex"
      ? config.codex.timeoutMs
      : DEFAULT_CODEX_TIMEOUT_MS;
  } catch {
    return DEFAULT_CODEX_TIMEOUT_MS;
  }
}
