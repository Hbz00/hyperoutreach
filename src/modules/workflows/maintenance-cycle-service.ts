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

type MaintenanceCycleStageServices = Pick<
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

/** What the cycle offers a stage so the stage can stop itself. */
export type MaintenanceStageOptions = { signal: AbortSignal };

/**
 * The four stages, each additionally allowed to accept the cycle's deadline.
 *
 * The second parameter is optional so a stage that ignores it — a test double
 * standing in for one — still satisfies the type. It is the seam through which
 * a stage is made to actually stop: racing a promise against a timer bounds the
 * *cycle*, but the losing work keeps running and keeps holding whatever
 * advisory lock it took.
 */
export type MaintenanceCycleStages = {
  [Stage in keyof MaintenanceCycleStageServices]: (
    payload: Parameters<MaintenanceCycleStageServices[Stage]>[0],
    options?: MaintenanceStageOptions,
  ) => Promise<unknown>;
};

/** How long each stage may take before the cycle gives up on it. */
export type MaintenanceStageBudgetsMs = {
  inbound: number;
  followups: number;
  recovery: number;
  commands: number;
};

export class MaintenanceStageTimeoutError extends Error {
  override readonly name = "MaintenanceStageTimeoutError";
  constructor(stage: keyof MaintenanceStageBudgetsMs, budgetMs: number) {
    super(`Maintenance ${stage} stage exceeded ${budgetMs} ms`);
  }
}

/**
 * Runs one stage under its own deadline.
 *
 * `config/maintenance.json` has declared `stageMaximumsMs` since the schema was
 * written and nothing ever read it. A stage could therefore run forever, and
 * one did: an inbound round held the lease for twenty-eight minutes while the
 * heartbeat kept renewing it, so the stale-lease takeover never fired and the
 * whole pipeline — mail, follow-ups, recovery, operator commands — stopped
 * without a single failed audit row.
 *
 * The signal is aborted before the rejection, so a stage that consumes it is
 * told to stop. Ownership must outlive the underlying work, including its
 * asynchronous cleanup: abort notification alone does not prove it stopped. Inbound
 * cancels the round in flight, because an abandoned IMAP fetch holds its
 * advisory lock until its own socket timeouts fire and the next cycle's inbound
 * stage then queues behind that same lock. The other three stop at the boundary
 * between items: each is a loop over independent work, and abandoning a send or
 * an AI turn halfway would cost more than finishing the one already started.
 * What they skip is not lost — every one of those lanes finds its work again by
 * query on the next tick.
 */
async function runStage<T>(
  stage: keyof MaintenanceStageBudgetsMs,
  budgetMs: number,
  run: (options: MaintenanceStageOptions) => Promise<T>,
  retainWork: (settlement: Promise<void>) => void,
): Promise<T> {
  const controller = new AbortController();
  const work = Promise.resolve().then(() => run({ signal: controller.signal }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Observe both outcomes immediately, including a rejection triggered by
      // abort. The caller reports failure now but retains the singleton until
      // this exact operation finishes; a late result cannot become success.
      retainWork(
        work.then(
          () => undefined,
          () => undefined,
        ),
      );
      controller.abort();
      reject(new MaintenanceStageTimeoutError(stage, budgetMs));
    }, budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  stageBudgetsMs?: Partial<MaintenanceStageBudgetsMs>;
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
  const budgets: MaintenanceStageBudgetsMs = {
    ...maintenanceConfig.stageMaximumsMs,
    ...options.stageBudgetsMs,
  };
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
        if (!(await renewLease())) break;
      } catch {
        // A stage-boundary renewal remains authoritative. A transient
        // background renewal failure must not create an unhandled rejection.
      }
    }
  })();

  let pendingWork: Promise<void> | undefined;
  const retainWork = (settlement: Promise<void>) => {
    pendingWork = settlement;
  };
  const stopHeartbeat = async () => {
    stoppingHeartbeat = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    releaseHeartbeatWait?.();
    await heartbeatLoop;
  };

  let currentStage: MaintenanceFailureStage = "inbound";
  try {
    const stagePayload = { observedAt: payload.observedAt };
    const inbound = await runStage(
      "inbound",
      budgets.inbound,
      (stageOptions) =>
        stages["reconcile-inbound-mailboxes"](stagePayload, stageOptions),
      retainWork,
    );
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "followup";
    const followups = await runStage(
      "followups",
      budgets.followups,
      (stageOptions) =>
        stages["reconcile-due-follow-ups"](stagePayload, stageOptions),
      retainWork,
    );
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "recovery";
    const recovery = await runStage(
      "recovery",
      budgets.recovery,
      (stageOptions) =>
        stages["recover-stale-work"](stagePayload, stageOptions),
      retainWork,
    );
    if (!(await renewLease())) return { status: "busy" };
    currentStage = "commands";
    const commands = await runStage(
      "commands",
      budgets.commands,
      (stageOptions) =>
        stages["drain-operator-commands"](stagePayload, stageOptions),
      retainWork,
    );
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
        ...(pendingWork ? {} : { ownerToken: null }),
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
    if (pendingWork) {
      // The request must report the deadline promptly, while the lease guards
      // work still running in this process. Drain the heartbeat before release
      // and fence cleanup so it cannot clear a replacement owner's lease.
      void pendingWork
        .then(async () => {
          await stopHeartbeat();
          await db
            .update(maintenanceState)
            .set({
              ownerToken: null,
              updatedAt: clock(),
            })
            .where(
              and(
                eq(maintenanceState.id, 1),
                eq(maintenanceState.ownerToken, ownerToken),
              ),
            );
        })
        .catch(() => {
          // Failure was already reported. A failed release stops renewing and
          // expires through the existing stale-lease takeover mechanism.
        });
    } else {
      await stopHeartbeat();
    }
  }
}
