export type MaintenanceStatus =
  "not_started" | "running" | "stalled" | "failed" | "overdue" | "healthy";

export interface MaintenanceStatusProjection {
  ownerToken: string | null;
  cycleStartedAt: Date | null;
  heartbeatAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
}

export interface MaintenanceStatusOptions {
  now: Date;
  intervalMs: number;
  codeTimeoutMs: number;
  staleLeaseMs: number;
}

export interface ResolvedMaintenanceStatus {
  state: MaintenanceStatus;
  overdueWindowMs: number;
}

export function getMaintenanceOverdueWindowMs({
  intervalMs,
  codeTimeoutMs,
}: Pick<MaintenanceStatusOptions, "intervalMs" | "codeTimeoutMs">): number {
  return Math.max(codeTimeoutMs + intervalMs, 3 * intervalMs);
}

export function resolveMaintenanceStatus(
  projection: MaintenanceStatusProjection,
  options: MaintenanceStatusOptions,
): ResolvedMaintenanceStatus {
  const overdueWindowMs = getMaintenanceOverdueWindowMs(options);
  const heartbeatAgeMs = projection.heartbeatAt
    ? options.now.getTime() - projection.heartbeatAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (projection.ownerToken && heartbeatAgeMs <= options.staleLeaseMs) {
    return { state: "running", overdueWindowMs };
  }

  const hasEverStarted = Boolean(
    projection.ownerToken ||
    projection.cycleStartedAt ||
    projection.heartbeatAt ||
    projection.lastSucceededAt ||
    projection.lastFailedAt,
  );
  if (!hasEverStarted) {
    return { state: "not_started", overdueWindowMs };
  }

  if (projection.ownerToken) {
    return { state: "stalled", overdueWindowMs };
  }

  if (
    projection.lastFailedAt &&
    (!projection.lastSucceededAt ||
      projection.lastFailedAt.getTime() > projection.lastSucceededAt.getTime())
  ) {
    return { state: "failed", overdueWindowMs };
  }

  const successAgeMs = projection.lastSucceededAt
    ? options.now.getTime() - projection.lastSucceededAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (successAgeMs > overdueWindowMs) {
    return { state: "overdue", overdueWindowMs };
  }

  return { state: "healthy", overdueWindowMs };
}
