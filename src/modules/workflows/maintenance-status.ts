import maintenanceConfig from "../../../config/maintenance.json";

/**
 * How long a cycle may legitimately be in flight.
 *
 * The sum of every stage's own deadline, plus one interval of slack for the
 * bookkeeping between them. Past this a cycle cannot still be working, because
 * each stage is bounded — so a fresh heartbeat past this point proves the
 * process is alive and the work is not, which are the two things a single
 * "running" state used to conflate.
 */
export function getMaintenanceCycleCeilingMs(intervalMs: number): number {
  const stages = maintenanceConfig.stageMaximumsMs;
  return (
    stages.inbound +
    stages.followups +
    stages.recovery +
    stages.commands +
    intervalMs
  );
}

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
    // A heartbeat says the process lives; it says nothing about progress. Every
    // stage is deadlined, so a cycle older than all of them together is stuck
    // rather than busy, and the operator is owed the difference.
    const cycleAgeMs = projection.cycleStartedAt
      ? options.now.getTime() - projection.cycleStartedAt.getTime()
      : 0;
    if (cycleAgeMs > getMaintenanceCycleCeilingMs(options.intervalMs)) {
      return { state: "stalled", overdueWindowMs };
    }
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
