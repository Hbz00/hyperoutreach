export function sanitizeMaintenanceError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";
  return message
    .replace(
      /\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;}]+/gi,
      "Authorization: [REDACTED]",
    )
    .replace(
      /\b(password|token|secret|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s'"\])]+/gi, "[REDACTED_URL]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
}

export const MAINTENANCE_FAILURE_MESSAGES = {
  inbound: "Maintenance inbound stage failed",
  followup: "Maintenance follow-up stage failed",
  recovery: "Maintenance recovery stage failed",
  commands: "Maintenance operator command stage failed",
  finalization: "Maintenance finalization failed",
} as const;

export type MaintenanceFailureStage = keyof typeof MAINTENANCE_FAILURE_MESSAGES;

export class MaintenanceCycleError extends Error {
  override readonly name = "MaintenanceCycleError";
  readonly auditMessage: (typeof MAINTENANCE_FAILURE_MESSAGES)[MaintenanceFailureStage];

  constructor(stage: MaintenanceFailureStage) {
    super("Maintenance cycle failed");
    this.auditMessage = MAINTENANCE_FAILURE_MESSAGES[stage];
  }
}

export function getSafeWorkflowAuditError(error: unknown): string {
  return error instanceof MaintenanceCycleError
    ? error.auditMessage
    : "Workflow task failed";
}
