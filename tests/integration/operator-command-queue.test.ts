import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  drainOperatorCommands,
  enqueueOperatorCommand,
} from "@/modules/workflows/operator-command-queue";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

async function queueResearch(overrides: { dedupeKey?: string } = {}) {
  return enqueueOperatorCommand(db, {
    command: "research-account",
    payload: { accountId: crypto.randomUUID() },
    requestedBy: "operator@example.com",
    ...overrides,
  });
}

async function readCommand(id: string) {
  const [row] = await db
    .select()
    .from(schema.operatorCommands)
    .where(eq(schema.operatorCommands.id, id));
  return row!;
}

describe("operator command queue", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  // The queue serves the oldest row first, so a leftover from an earlier test
  // would be the one drained here. Each test starts from an empty queue.
  beforeEach(async () => {
    await db.delete(schema.operatorCommands);
  });

  it("queues work and returns without running it", async () => {
    const queued = await queueResearch();

    expect(queued).toMatchObject({ duplicate: false, status: "queued" });
    // Nothing ran, proven by the row: an executed command would carry a run
    // id, a start time and an attempt.
    expect(await readCommand(queued.id)).toMatchObject({
      attempt: 0,
      runId: null,
      startedAt: null,
      claimId: null,
    });
  });

  // The two properties the queue rests on, neither of which the state machine
  // tests exercise: two passes overlapping must not take the same row, and a
  // pass whose claim was stolen must not write its outcome over the new one.
  it("never hands one command to two overlapping passes", async () => {
    await queueResearch();
    const runs: string[] = [];
    const slowly = async (input: { runId: string }) => {
      runs.push(input.runId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    };

    await Promise.all([
      drainOperatorCommands(db, slowly, { now: NOW }),
      drainOperatorCommands(db, slowly, { now: NOW }),
    ]);

    expect(runs).toHaveLength(1);
  });

  it("refuses to record an outcome for a claim it no longer holds", async () => {
    const queued = await queueResearch();
    const drained = await drainOperatorCommands(
      db,
      async () => {
        // A second pass reclaims the row mid-run, as an expired lease would.
        await db
          .update(schema.operatorCommands)
          .set({ claimId: "someone-else" })
          .where(eq(schema.operatorCommands.id, queued.id));
        return { ok: true };
      },
      { now: NOW },
    );

    expect(drained).toEqual([]);
    expect(await readCommand(queued.id)).toMatchObject({
      status: "running",
      claimId: "someone-else",
    });
  });

  it("answers a repeated request with the row already queued", async () => {
    const key = `ui:research:${crypto.randomUUID()}`;
    const first = await queueResearch({ dedupeKey: key });
    const second = await queueResearch({ dedupeKey: key });

    expect(second).toMatchObject({ id: first.id, duplicate: true });
  });

  it("runs one command per drain and records its result", async () => {
    const queued = await queueResearch();
    const execute = vi.fn(async () => ({
      ok: true,
      disposition: "researched",
    }));

    const drained = await drainOperatorCommands(db, execute, { now: NOW });

    expect(drained).toEqual([
      expect.objectContaining({ id: queued.id, status: "succeeded" }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    const stored = await readCommand(queued.id);
    expect(stored).toMatchObject({
      status: "succeeded",
      attempt: 1,
      claimId: null,
      completedAt: expect.any(Date),
    });
    expect(stored.runId).toBeTruthy();
  });

  // The workflow services resolve their failures instead of throwing. A queue
  // that only watched for exceptions would file this as a success.
  it("does not record a returned failure as a success", async () => {
    const queued = await queueResearch();

    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "ACCOUNT_NOT_FOUND", message: "gone" }),
      { now: NOW },
    );

    expect(await readCommand(queued.id)).toMatchObject({
      status: "abandoned",
      error: "ACCOUNT_NOT_FOUND",
    });
  });

  // The ladder is 1, 5 then 15 minutes, and the run has to be long enough to
  // climb all of it. At three attempts it ended after the second wait: the
  // 15-minute step was unreachable and a command died six minutes into any
  // outage — while the outage this transport actually has is the operator's
  // ChatGPT desktop app closed, updating, or asleep with the laptop. Each
  // wait is asserted on its exact value rather than by jumping an hour ahead,
  // because the top of the ladder is the part that was never exercised.
  it("climbs the whole retry ladder before giving up visibly", async () => {
    const queued = await queueResearch();
    const execute = async () => ({ ok: false, code: "AGENT_ERROR" });

    await drainOperatorCommands(db, execute, { now: NOW });
    const afterFirst = await readCommand(queued.id);
    expect(afterFirst).toMatchObject({ status: "queued", attempt: 1 });
    expect(afterFirst.nextAttemptAt).toEqual(later(60_000));

    // Too early: the backoff has not elapsed, so nothing is claimed.
    expect(
      await drainOperatorCommands(db, execute, { now: later(1_000) }),
    ).toEqual([]);

    await drainOperatorCommands(db, execute, { now: later(60_000) });
    const afterSecond = await readCommand(queued.id);
    expect(afterSecond).toMatchObject({ status: "queued", attempt: 2 });
    expect(afterSecond.nextAttemptAt).toEqual(later(60_000 + 300_000));

    await drainOperatorCommands(db, execute, { now: later(360_000) });
    const afterThird = await readCommand(queued.id);
    expect(afterThird).toMatchObject({ status: "queued", attempt: 3 });
    // The step that did not exist before: fifteen minutes, not abandonment.
    expect(afterThird.nextAttemptAt).toEqual(later(360_000 + 900_000));

    await drainOperatorCommands(db, execute, { now: later(1_260_000) });
    expect(await readCommand(queued.id)).toMatchObject({
      status: "abandoned",
      attempt: 4,
      error: "AGENT_ERROR",
    });

    // The other half of "bounded": an abandoned command must stop costing
    // turns on the operator's subscription, not merely stop being counted.
    const afterAbandon = vi.fn(async () => ({ ok: true }));
    await drainOperatorCommands(db, afterAbandon, { now: later(86_400_000) });
    expect(afterAbandon).not.toHaveBeenCalled();
  });

  // A handful of parked rows are older than everything queued behind them.
  // Ordering on age alone would let them take every claim of every pass and
  // starve the very commands that would lift their preconditions.
  it("serves runnable work before re-checking what is parked", async () => {
    const parked = [];
    for (let index = 0; index < 3; index += 1) {
      parked.push(await queueResearch());
    }
    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "REPLY_PENDING" }),
      { now: NOW },
    );
    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "REPLY_PENDING" }),
      { now: NOW },
    );
    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "REPLY_PENDING" }),
      { now: NOW },
    );
    for (const row of parked) {
      expect(await readCommand(row.id)).toMatchObject({ status: "waiting" });
    }

    // Queued last, and due at the same instant the parked rows are.
    const newest = await queueResearch();
    const seen: string[] = [];

    await drainOperatorCommands(
      db,
      async (input) => {
        seen.push(String(input.payload.accountId));
        return { ok: true };
      },
      { now: later(10 * 60_000) },
    );

    const newestRow = await readCommand(newest.id);
    // Runnable work first. The parked rows are re-checked afterwards in the
    // same pass, which is right: nothing here spends a turn on the operator's
    // window, so there is no reason to make them wait another minute.
    expect(seen[0]).toBe(String(newestRow.payload.accountId));
    expect(newestRow.status).toBe("succeeded");
  });

  it("retries what threw, and reports the failure rather than swallowing it", async () => {
    const queued = await queueResearch({ dedupeKey: crypto.randomUUID() });

    await drainOperatorCommands(
      db,
      async () => {
        throw new Error("Workflow task failed");
      },
      { now: NOW },
    );

    expect(await readCommand(queued.id)).toMatchObject({
      status: "queued",
      attempt: 1,
      error: "Workflow task failed",
    });
  });

  // Work that could not start is not work that failed. Spending the retry
  // budget on it would abandon something nobody got wrong.
  it("parks a precondition failure without spending an attempt", async () => {
    const queued = await queueResearch();

    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "REPLY_PENDING" }),
      { now: NOW },
    );

    const parked = await readCommand(queued.id);
    expect(parked).toMatchObject({
      status: "waiting",
      waitingReason: "awaiting_reply_classification",
      attempt: 0,
    });
    expect(parked.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("asks the service again once a parked command is due", async () => {
    const queued = await queueResearch();
    await drainOperatorCommands(
      db,
      async () => ({ ok: false, code: "REPLY_PENDING" }),
      { now: NOW },
    );

    await drainOperatorCommands(db, async () => ({ ok: true }), {
      now: later(10 * 60_000),
    });

    expect(await readCommand(queued.id)).toMatchObject({
      status: "succeeded",
      // The parked round gave its attempt back, so the run that finally
      // executed is the first one charged.
      attempt: 1,
    });
  });

  it("takes the oldest work first", async () => {
    const first = await queueResearch();
    const second = await queueResearch();
    const seen: string[] = [];
    const record = async (input: { payload: Record<string, unknown> }) => {
      seen.push(String(input.payload.accountId));
      return { ok: true };
    };

    await drainOperatorCommands(db, record, { now: NOW });
    await drainOperatorCommands(db, record, { now: NOW });

    const firstRow = await readCommand(first.id);
    const secondRow = await readCommand(second.id);
    expect(seen[0]).toBe(String(firstRow.payload.accountId));
    expect(seen[1]).toBe(String(secondRow.payload.accountId));
  });

  /**
   * The bound exists because an AI turn holds the operator's single ChatGPT
   * window and can last ten minutes. It is not a reason to make a second command
   * wait a whole minute for its own pass, so the pass stops at the first turn
   * actually spent rather than at the first command that might have spent one.
   *
   * The executor here writes the `agent_runs` row a real AI path writes before
   * it calls the provider, because that row is what the queue now reads. A stub
   * that only returned `{ok: true}` would be claiming to have used a window it
   * never touched.
   */
  it("spends at most one AI turn per pass", async () => {
    await queueResearch();
    await queueResearch();
    let runs = 0;

    const drained = await drainOperatorCommands(
      db,
      async () => {
        runs += 1;
        await db.insert(schema.agentRuns).values({
          agent: "account_research",
          model: "test-model",
          promptVersion: "test-prompt-v1",
          schemaVersion: "test-schema-v1",
          input: {},
          status: "succeeded",
        });
        return { ok: true };
      },
      { now: NOW, limit: 20 },
    );

    expect(runs).toBe(1);
    expect(drained).toHaveLength(1);
  });

  /**
   * The other half, and the reason the rule changed from a prediction to an
   * observation: a resolution that reuses a company search already on record
   * asks the model nothing, and stopping the pass for it is what made ten
   * colleagues at one company take ten minutes.
   */
  it("keeps draining commands that never reach the AI surface", async () => {
    await queueResearch();
    await queueResearch();
    await queueResearch();
    let runs = 0;

    const drained = await drainOperatorCommands(
      db,
      async () => {
        runs += 1;
        return { ok: true };
      },
      { now: NOW, limit: 20 },
    );

    expect(runs).toBe(3);
    expect(drained).toHaveLength(3);
  });

  /** A turn spent by a command that then failed still holds the window. */
  it("stops the pass when a command spends a turn and then throws", async () => {
    await queueResearch();
    await queueResearch();
    let runs = 0;

    await drainOperatorCommands(
      db,
      async () => {
        runs += 1;
        await db.insert(schema.agentRuns).values({
          agent: "account_research",
          model: "test-model",
          promptVersion: "test-prompt-v1",
          schemaVersion: "test-schema-v1",
          input: {},
          status: "failed",
        });
        throw new Error("provider exploded");
      },
      { now: NOW, limit: 20 },
    );

    expect(runs).toBe(1);
  });

  it("reclaims a command whose executor died mid-run", async () => {
    const queued = await queueResearch();
    await db
      .update(schema.operatorCommands)
      .set({
        status: "running",
        claimId: "dead-cycle",
        claimedAt: new Date(NOW.getTime() - 60 * 60_000),
        attempt: 1,
      })
      .where(eq(schema.operatorCommands.id, queued.id));

    await drainOperatorCommands(db, async () => ({ ok: true }), { now: NOW });

    expect(await readCommand(queued.id)).toMatchObject({
      status: "succeeded",
      // The dead run consumed a real turn, so reclaiming it counts. A crash
      // loop must exhaust its budget rather than spend the subscription
      // forever.
      attempt: 2,
    });
  });

  it("leaves a live claim alone", async () => {
    const queued = await queueResearch();
    await db
      .update(schema.operatorCommands)
      .set({
        status: "running",
        claimId: "live-cycle",
        claimedAt: NOW,
      })
      .where(eq(schema.operatorCommands.id, queued.id));

    const execute = vi.fn(async () => ({ ok: true }));
    expect(await drainOperatorCommands(db, execute, { now: NOW })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * A pass is not an instant: one AI command holds it for minutes. These three
   * read the clock again during the pass, which is what the queue does in
   * production — `service-factory` passes neither `now` nor `clock`.
   *
   * The regression they pin: every timestamp used to come from the pass's start,
   * so a command that ran for 84 seconds recorded a zero duration and a
   * one-minute retry rung was already spent by the time it was written.
   */
  describe("timing within a long pass", () => {
    // Advances by `stepMs` on every read, so the instant after the work is
    // later than the instant before it — exactly what a real clock does and a
    // pinned `now` cannot.
    const advancingClock = (from: Date, stepMs: number) => {
      let reads = 0;
      return () => new Date(from.getTime() + stepMs * reads++);
    };

    it("records when the attempt ended, not when the pass began", async () => {
      const queued = await queueResearch();

      await drainOperatorCommands(
        db,
        async () => ({ ok: true }),
        // Two reads per command: the claim, then the finalisation.
        { now: NOW, clock: advancingClock(NOW, 90_000) },
      );

      const row = await readCommand(queued.id);
      expect(row.status).toBe("succeeded");
      expect(row.startedAt).toEqual(NOW);
      expect(row.completedAt).toEqual(later(90_000));
      // The point of the whole change: a 90-second command must not record
      // itself as instantaneous. No page renders these two columns today —
      // `readQueuedWork` drops them and excludes succeeded rows — so this is
      // for whoever reads the table when something looks slow, and for the
      // retry backoff that counts from the same instant.
      expect(row.completedAt!.getTime() - row.startedAt!.getTime()).toBe(
        90_000,
      );
    });

    it("counts the retry backoff from the failure, not from before the attempt", async () => {
      const queued = await queueResearch();

      await drainOperatorCommands(
        db,
        async () => {
          throw new Error("provider unavailable");
        },
        { now: NOW, clock: advancingClock(NOW, 100_000) },
      );

      const row = await readCommand(queued.id);
      expect(row.status).toBe("queued");
      expect(row.attempt).toBe(1);
      // Failure at NOW+100s, first rung 60s: the wait must start at the
      // failure. Measured from the pass start it would be NOW+60s — already
      // past when written, so the next tick would retry with no wait at all.
      expect(row.nextAttemptAt).toEqual(later(160_000));
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(
        later(100_000).getTime(),
      );
    });

    /**
     * The production call site passes neither `now` nor `clock`
     * (`service-factory`'s `drain-operator-commands`), so this is the wiring
     * that actually runs every minute — and the one that recorded every
     * command as instantaneous.
     */
    it("measures a real duration when no clock is injected", async () => {
      const queued = await queueResearch();

      await drainOperatorCommands(db, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true };
      });

      const row = await readCommand(queued.id);
      expect(row.status).toBe("succeeded");
      expect(row.completedAt!.getTime()).toBeGreaterThan(
        row.startedAt!.getTime(),
      );
    });
  });
});
