import { randomUUID } from "node:crypto";

import { and, eq, isNull, lt, or } from "drizzle-orm";

import maintenanceConfig from "../../../config/maintenance.json";
import { maintenanceState } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  MaintenanceCycleError,
  type MaintenanceFailureStage,
} from "@/modules/workflows/maintenance-error";
import type { WorkflowTaskServices } from "@/modules/workflows/runtime";
import type { WorkflowPayloads } from "@/modules/workflows/task-contracts";

export type MaintenanceCycleStages = Pick<
  WorkflowTaskServices,
  | "reconcile-inbound-mailboxes"
  | "reconcile-due-follow-ups"
  | "recover-stale-work"
> & {
  /**
   * Work an operator asked for, run here rather than in their request. Last on
   * purpose: it is the only stage whose duration is chosen by the operator,
   * and the three ahead of it keep the mailbox, the sequence and the send
   * queue moving on every tick regardless.
   */
  "drain-operator-commands": (payload: {
    observedAt?: string;
  }) => Promise<unknown>;
};

export type MaintenanceCycleResult =
  | { status: "busy" }
  | {
      status: "succeeded";
      stages: {
        inbound: unknown;
        followups: unknown;
        recovery: unknown;
        commands: unknown;
      };
    };

export type MaintenanceCycleOptions = {
  clock?: () => Date;
  createOwnerToken?: () => string;
  heartbeatMs?: number;
  leaseStaleMs?: number;
};

export async function runMaintenanceCycle(
  db: AppDatabase,
  stages: MaintenanceCycleStages,
  payload: WorkflowPayloads["maintenance-cycle"],
  options: MaintenanceCycleOptions = {},
): Promise<MaintenanceCycleResult> {
  const clock = options.clock ?? (() => new Date());
  const ownerToken = (options.createOwnerToken ?? randomUUID)();
  const heartbeatMs =
    options.heartbeatMs ?? maintenanceConfig.heartbeatIntervalMs;
  const leaseStaleMs = options.leaseStaleMs ?? maintenanceConfig.staleLeaseMs;
  const claimedAt = clock();
  const staleBefore = new Date(claimedAt.getTime() - leaseStaleMs);
  const [claimed] = await db
    .update(maintenanceState)
    .set({
      ownerToken,
      cycleStartedAt: claimedAt,
      heartbeatAt: claimedAt,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(maintenanceState.id, 1),
        or(
          isNull(maintenanceState.ownerToken),
          isNull(maintenanceState.heartbeatAt),
          lt(maintenanceState.heartbeatAt, staleBefore),
        ),
      ),
    )
    .returning({ id: maintenanceState.id });
  if (!claimed) return { status: "busy" };

  const heartbeat = async (): Promise<boolean> => {
    const now = clock();
    const [renewed] = await db
      .update(maintenanceState)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(
        and(
          eq(maintenanceState.id, 1),
          eq(maintenanceState.ownerToken, ownerToken),
        ),
      )
      .returning({ id: maintenanceState.id });
    return Boolean(renewed);
  };

  let activeRenewal: Promise<boolean> | undefined;
  const renewLease = (): Promise<boolean> => {
    if (activeRenewal) return activeRenewal;
    const renewal = heartbeat().finally(() => {
      if (activeRenewal === renewal) activeRenewal = undefined;
    });
    activeRenewal = renewal;
    return renewal;
  };
  let stoppingHeartbeat = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseHeartbeatWait: (() => void) | undefined;
  const waitForHeartbeat = () =>
    new Promise<void>((resolve) => {
      releaseHeartbeatWait = resolve;
      heartbeatTimer = setTimeout(resolve, heartbeatMs);
      heartbeatTimer.unref();
    }).finally(() => {
      heartbeatTimer = undefined;
      releaseHeartbeatWait = undefined;
    });
  const heartbeatLoop = (async () => {
    while (!stoppingHeartbeat) {
      await waitForHeartbeat();
      if (stoppingHeartbeat) break;
      try {
        await renewLease();
      } catch {
        // A stage-boundary renewal remains authoritative. A transient
        // background renewal failure must not create an unhandled rejection.
      }
    }
  })();

  let currentStage: MaintenanceFailureStage = "inbound";
  try {
    const stagePayload = { observedAt: payload.observedAt };
    const inbound = await stages["reconcile-inbound-mailboxes"](stagePayload);
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "followup";
    const followups = await stages["reconcile-due-follow-ups"](stagePayload);
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "recovery";
    const recovery = await stages["recover-stale-work"](stagePayload);
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "commands";
    const commands = await stages["drain-operator-commands"](stagePayload);
    currentStage = "finalization";
    const completedAt = clock();
    const [completed] = await db
      .update(maintenanceState)
      .set({
        ownerToken: null,
        heartbeatAt: completedAt,
        lastSucceededAt: completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(maintenanceState.id, 1),
          eq(maintenanceState.ownerToken, ownerToken),
        ),
      )
      .returning({ id: maintenanceState.id });
    if (!completed) return { status: "busy" };
    return {
      status: "succeeded",
      stages: { inbound, followups, recovery, commands },
    };
  } catch {
    const failedAt = clock();
    const safeError = new MaintenanceCycleError(currentStage);
    const [failed] = await db
      .update(maintenanceState)
      .set({
        ownerToken: null,
        heartbeatAt: failedAt,
        lastFailedAt: failedAt,
        lastError: safeError.auditMessage,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(maintenanceState.id, 1),
          eq(maintenanceState.ownerToken, ownerToken),
        ),
      )
      .returning({ id: maintenanceState.id });
    if (!failed) return { status: "busy" };
    throw safeError;
  } finally {
    stoppingHeartbeat = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    releaseHeartbeatWait?.();
    await heartbeatLoop;
  }
}
