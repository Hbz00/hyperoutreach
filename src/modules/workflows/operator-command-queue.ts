import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { operatorCommands } from "@/lib/db/schema";
import { sanitizeMaintenanceError } from "@/modules/workflows/maintenance-error";
import type { AppDatabase } from "@/lib/db/types";
import {
  classifyCommandOutcome,
  QUEUED_OPERATOR_COMMANDS,
  type QueuedOperatorCommand,
} from "@/modules/workflows/operator-command-policy";
import { prepareCommand } from "@/modules/workflows/operator-command-preconditions";

export type OperatorCommandRow = typeof operatorCommands.$inferSelect;

/**
 * How long after each failed attempt the queue tries again.
 *
 * Three waits for four attempts, spanning twenty-one minutes. The span is
 * chosen against the outage this transport actually has — the operator's
 * ChatGPT desktop app closed, updating, or asleep with the laptop — not
 * against a network blip. Changing `maxAttempts` without extending this array
 * is safe: the last wait repeats.
 */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** How long a parked command waits before asking the service again. */
const WAITING_RECHECK_MS = 5 * 60_000;
/** A claim older than this belonged to a cycle that died mid-run. */
const CLAIM_LEASE_MS = 15 * 60_000;

export type OperatorCommandExecutor = (input: {
  task: string;
  payload: Record<string, unknown>;
  runId: string;
  attempt: number;
}) => Promise<unknown>;

export type EnqueuedOperatorCommand = {
  id: string;
  duplicate: boolean;
  status: OperatorCommandRow["status"];
};

/**
 * Records work for the maintenance cycle to run, and returns immediately.
 *
 * A duplicate `dedupeKey` returns the row that already exists rather than an
 * error: the operator pressed a button twice, which is not a failure, and the
 * answer they need is "it is already queued".
 */
export async function enqueueOperatorCommand(
  db: AppDatabase,
  input: {
    command: QueuedOperatorCommand;
    payload: Record<string, unknown>;
    requestedBy: string;
    dedupeKey?: string;
    maxAttempts?: number;
  },
): Promise<EnqueuedOperatorCommand> {
  const [created] = await db
    .insert(operatorCommands)
    .values({
      command: input.command,
      task: QUEUED_OPERATOR_COMMANDS[input.command],
      payload: input.payload,
      requestedBy: input.requestedBy,
      dedupeKey: input.dedupeKey ?? null,
      ...(input.maxAttempts === undefined
        ? {}
        : { maxAttempts: input.maxAttempts }),
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return { id: created.id, duplicate: false, status: created.status };
  }
  const [existing] = await db
    .select()
    .from(operatorCommands)
    .where(eq(operatorCommands.dedupeKey, input.dedupeKey ?? ""))
    .limit(1);
  if (!existing) throw new Error("Operator command could not be queued");
  return { id: existing.id, duplicate: true, status: existing.status };
}

export type DrainedOperatorCommand = {
  id: string;
  command: string;
  status: OperatorCommandRow["status"];
  attempt: number;
  reason?: string;
};

/**
 * Runs at most `limit` queued commands, one at a time.
 *
 * Claiming is a single compare-and-swap so a lease that expired while an
 * earlier cycle was still running cannot hand the same row to two executors,
 * and completion is fenced on the claim id for the same reason. An attempt is
 * only spent by work that was actually attempted: a command parked because its
 * precondition is not met comes back on a slower cadence with its retry budget
 * untouched, because spending the ladder on something that never started would
 * abandon work nobody got wrong.
 */
export async function drainOperatorCommands(
  db: AppDatabase,
  execute: OperatorCommandExecutor,
  options: { now?: Date; limit?: number } = {},
): Promise<DrainedOperatorCommand[]> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  // Parking is not doing work, so it does not spend the pass's budget — but it
  // still costs a claim, so it gets a ceiling of its own rather than none.
  const parkLimit = limit * 2;
  const drained: DrainedOperatorCommand[] = [];
  let executed = 0;
  let parked = 0;

  while (executed < limit && parked < parkLimit) {
    const claimId = randomUUID();
    const runId = `command_${randomUUID()}`;
    const claimed = await claimNextCommand(db, { now, claimId, runId });
    if (!claimed) break;

    // Nothing was tried yet, so a missing precondition is a wait rather than a
    // failed attempt — `finalizeCommand` gives the attempt back. A precondition
    // that can never be met is neither: it is a stop, said out loud.
    const prepared = await prepareCommand(db, claimed);
    if (prepared.kind !== "ready") {
      // Both branches draw on the parking budget rather than the pass's work
      // budget. Neither ran anything, but both cost a claim — and a backlog of
      // orphaned rows would otherwise drain in a single unbounded pass.
      parked += 1;
      const settledRow = await finalizeCommand(
        db,
        claimed,
        claimId,
        prepared.kind === "waiting"
          ? { kind: "waiting", reason: prepared.reason }
          : { kind: "abandoned", reason: prepared.reason },
        { now, result: null },
      );
      if (settledRow) drained.push(settledRow);
      continue;
    }
    executed += 1;

    let outcome:
      | { status: "threw"; message: string }
      | { status: "returned"; value: unknown };
    try {
      const value = await execute({
        task: claimed.task,
        payload: prepared.payload,
        runId,
        attempt: claimed.attempt,
      });
      outcome = { status: "returned", value };
    } catch (error) {
      outcome = {
        status: "threw",
        // Anything thrown before the audit wrapper re-labels it — a schema
        // parse, a driver error naming a host — lands verbatim in a column the
        // operator reads. The rest of the tree sanitizes before it stores; so
        // does this.
        message: sanitizeMaintenanceError(error),
      };
    }

    const disposition = classifyCommandOutcome(outcome);
    const finished = await finalizeCommand(db, claimed, claimId, disposition, {
      now,
      result: outcome.status === "returned" ? outcome.value : null,
    });
    if (finished) drained.push(finished);

    // One AI turn per pass. The bound exists because that turn holds the
    // operator's single ChatGPT window and can last ten minutes — it is not a
    // reason to make a deterministic generation wait a minute for its turn.
    // Whether this command took a turn is answered by `prepareCommand`, not by
    // the task name: `generate-message` is deterministic interpolation until a
    // step declares an agent-written field, and reading the name alone let a
    // burst of enrolments on a personalized campaign spend the window once per
    // command in a single pass.
    if (prepared.usesAi) break;
  }
  return drained;
}

async function claimNextCommand(
  db: AppDatabase,
  context: { now: Date; claimId: string; runId: string },
): Promise<OperatorCommandRow | null> {
  const staleBefore = new Date(context.now.getTime() - CLAIM_LEASE_MS);
  return db.transaction(async (tx) => {
    // `for update skip locked` holds the row for this transaction, so two
    // cycles overlapping on an expired lease cannot both take the same work,
    // and neither waits on the other.
    const [candidate] = await tx
      .select({ id: operatorCommands.id, status: operatorCommands.status })
      .from(operatorCommands)
      .where(
        or(
          and(
            inArray(operatorCommands.status, ["queued", "waiting"]),
            or(
              isNull(operatorCommands.nextAttemptAt),
              lte(operatorCommands.nextAttemptAt, context.now),
            ),
          ),
          and(
            eq(operatorCommands.status, "running"),
            lt(operatorCommands.claimedAt, staleBefore),
          ),
        ),
      )
      // Runnable work first, then the oldest. A parked row becomes eligible
      // again every few minutes and is by definition older than whatever was
      // queued after it; ordering on age alone would let a handful of them
      // take every claim of every pass and starve the very commands that would
      // lift their preconditions.
      //
      // The symmetric cost is that a parked row is only re-checked once no
      // runnable work is due. At one operator's volume the queue is empty most
      // of the time, and the commands that lift a wait are exactly the ones
      // this ordering serves first — so the wait ends sooner, not later. A
      // continuous backlog would defer re-checks, which is the right trade:
      // work that can run should.
      .orderBy(
        asc(
          sql`case when ${operatorCommands.status} = 'waiting' then 1 else 0 end`,
        ),
        asc(operatorCommands.createdAt),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(operatorCommands)
      .set({
        status: "running",
        // Running is not waiting. The table's own check constraint enforces
        // that the reason and the state agree, and it caught this.
        waitingReason: null,
        claimId: context.claimId,
        claimedAt: context.now,
        startedAt: context.now,
        runId: context.runId,
        // Every claim counts, including one that reclaims a dead lease: that
        // run consumed a real turn on the operator's subscription, and not
        // counting it would let a crash loop spend the budget forever. The
        // one exception is rolled back at finalisation — see the `waiting`
        // branch, where the work never actually started.
        attempt: sql`${operatorCommands.attempt} + 1`,
      })
      .where(eq(operatorCommands.id, candidate.id))
      .returning();
    return claimed ?? null;
  });
}

async function finalizeCommand(
  db: AppDatabase,
  claimed: OperatorCommandRow,
  claimId: string,
  disposition: ReturnType<typeof classifyCommandOutcome>,
  context: { now: Date; result: unknown },
): Promise<DrainedOperatorCommand | null> {
  const base = {
    claimId: null,
    claimedAt: null,
    result: (context.result ?? null) as Record<string, unknown> | null,
  };
  const patch =
    disposition.kind === "succeeded"
      ? {
          ...base,
          status: "succeeded" as const,
          waitingReason: null,
          error: null,
          completedAt: context.now,
          nextAttemptAt: null,
        }
      : disposition.kind === "waiting"
        ? {
            ...base,
            status: "waiting" as const,
            waitingReason: disposition.reason,
            error: null,
            completedAt: null,
            nextAttemptAt: new Date(context.now.getTime() + WAITING_RECHECK_MS),
            // Give the attempt back. The precondition was not met, so nothing
            // was tried; charging the retry budget here would abandon work
            // nobody got wrong.
            attempt: Math.max(0, claimed.attempt - 1),
          }
        : disposition.kind === "retry" && claimed.attempt < claimed.maxAttempts
          ? {
              ...base,
              status: "queued" as const,
              waitingReason: null,
              error: disposition.reason,
              completedAt: null,
              nextAttemptAt: new Date(
                context.now.getTime() +
                  (RETRY_BACKOFF_MS[claimed.attempt - 1] ??
                    RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!),
              ),
            }
          : {
              ...base,
              status: "abandoned" as const,
              waitingReason: null,
              error: disposition.reason,
              completedAt: context.now,
              nextAttemptAt: null,
            };

  const [updated] = await db
    .update(operatorCommands)
    .set(patch)
    .where(
      and(
        eq(operatorCommands.id, claimed.id),
        eq(operatorCommands.claimId, claimId),
      ),
    )
    .returning();
  if (!updated) return null;
  return {
    id: updated.id,
    command: updated.command,
    status: updated.status,
    attempt: updated.attempt,
    ...(updated.error ? { reason: updated.error } : {}),
    ...(updated.waitingReason ? { reason: updated.waitingReason } : {}),
  };
}

/**
 * Puts an abandoned or parked command back in line, at the operator's request.
 *
 * The retry budget resets because the operator is not the system asking again
 * — they looked at the reason and decided it is worth another go. Re-running
 * through a dispatcher idempotency key would have been the alternative, and it
 * is exactly the mechanism that turns a repeat into a silent no-op.
 */
export async function requeueOperatorCommand(
  db: AppDatabase,
  input: { id: string; now?: Date },
): Promise<boolean> {
  const [updated] = await db
    .update(operatorCommands)
    .set({
      status: "queued",
      waitingReason: null,
      attempt: 0,
      nextAttemptAt: null,
      claimId: null,
      claimedAt: null,
      completedAt: null,
      error: null,
    })
    .where(
      and(
        eq(operatorCommands.id, input.id),
        inArray(operatorCommands.status, ["abandoned", "waiting"]),
      ),
    )
    .returning({ id: operatorCommands.id });
  return Boolean(updated);
}
