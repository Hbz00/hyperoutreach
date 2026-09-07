import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  ActionLockBusyError,
  actionLockKey,
  withActionLocks,
} from "@/lib/db/action-lock";
import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";

const { testUrl } = resolveDatabaseUrls(process.env);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function beforeDeadline<T>(promise: Promise<T>, ms = 1_500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForWaiters(
  observer: postgres.Sql,
  applicationName: string,
  expected: number,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [{ count }] = await observer<[{ count: number }]>`
      select count(*)::int as count
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and not l.granted
        and a.datname = current_database()
        and a.application_name = ${applicationName}
    `;
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Did not observe ${expected} blocked advisory-lock sessions`);
}

async function cancelWaiters(observer: postgres.Sql, applicationName: string) {
  await observer`
    select pg_cancel_backend(a.pid)
    from pg_stat_activity a
    where a.datname = current_database()
      and a.application_name = ${applicationName}
      and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'
  `;
}

describe("production action-lock contention", () => {
  it("lets a holder query the five-connection pool while four same-key actions wait", async () => {
    const applicationName = `lock-pool-${randomUUID()}`;
    const client = postgres(testUrl, {
      max: 5,
      connection: { application_name: applicationName },
    });
    const observer = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const key = actionLockKey.mailbox(randomUUID());
    const holderEntered = deferred();
    const letHolderQuery = deferred();
    const callbacks: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let holderFinishedQuery = false;
    const holder = settled(
      withActionLocks(db, [key], async () => {
        callbacks[0] += 1;
        holderEntered.resolve();
        await letHolderQuery.promise;
        // Reconciliation dependencies use the original shared pool even
        // while their caller owns the reserved action-lock session.
        await db.execute(sql`select 1`);
        holderFinishedQuery = true;
      }),
    );
    const contenders: Promise<PromiseSettledResult<void>>[] = [];
    try {
      expect(
        await beforeDeadline(
          Promise.race([holderEntered.promise.then(() => "entered"), holder]),
        ),
        "The holder must acquire its lock before contenders start",
      ).toBe("entered");
      for (const index of [1, 2, 3, 4] as const) {
        contenders.push(
          settled(
            withActionLocks(db, [key], async () => {
              expect(holderFinishedQuery).toBe(true);
              callbacks[index] += 1;
            }),
          ),
        );
      }
      await waitForWaiters(observer, applicationName, 4);
      letHolderQuery.resolve();
      expect(
        await beforeDeadline(holder),
        "The holder must finish without cancelling or releasing its own lock",
      ).toEqual({ status: "fulfilled", value: undefined });
      expect(await Promise.all(contenders)).toEqual(
        Array.from({ length: 4 }, () => ({
          status: "fulfilled",
          value: undefined,
        })),
      );
      expect(callbacks).toEqual([1, 1, 1, 1, 1]);
    } finally {
      letHolderQuery.resolve();
      // A failing pre-fix assertion must not leave the deadlocked sessions
      // alive or poison subsequent integration suites.
      try {
        await cancelWaiters(observer, applicationName);
        await Promise.all([holder, ...contenders]);
      } finally {
        await Promise.all([client.end(), observer.end()]);
      }
    }
  });

  it("does not replay an acquired callback that throws ActionLockBusyError", async () => {
    const client = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const callbackError = new ActionLockBusyError();
    let calls = 0;
    try {
      await expect(
        withActionLocks(
          db,
          [actionLockKey.settings(), actionLockKey.contact(randomUUID())],
          async (lockedDb) => {
            await lockedDb.execute(sql`select 1`);
            calls += 1;
            throw callbackError;
          },
          { globalAttempts: 3, globalRetryDelayMs: 0 },
        ),
      ).rejects.toBe(callbackError);
      expect(calls).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("restores session timeout and releases partial locks between acquisition attempts", async () => {
    const applicationName = `lock-timeout-${randomUUID()}`;
    const client = postgres(testUrl, {
      max: 1,
      connection: { application_name: applicationName, lock_timeout: 3_000 },
    });
    const observer = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const firstKey = `a:${randomUUID()}`;
    const heldKey = `z:${randomUUID()}`;
    let calls = 0;
    let reservation: Promise<postgres.ReservedSql> | undefined;
    let reserved: postgres.ReservedSql | undefined;
    let waiter: Promise<PromiseSettledResult<void>> | undefined;
    try {
      await observer`select pg_advisory_lock(hashtextextended(${heldKey}, 0))`;
      waiter = settled(
        withActionLocks(db, [heldKey, firstKey, firstKey], async (lockedDb) => {
          calls += 1;
          const rows = await lockedDb.execute(sql`show lock_timeout`);
          expect(rows[0]?.lock_timeout).toBe("3s");
        }),
      );
      await waitForWaiters(observer, applicationName, 1);
      reservation = client.reserve();
      reserved = await beforeDeadline(reservation);
      expect(
        reserved,
        "A blocked acquisition must return pool capacity before the external holder releases",
      ).toBeDefined();
      if (!reserved) throw new Error("No pool capacity returned");
      expect((await reserved`show lock_timeout`)[0]?.lock_timeout).toBe("3s");
      const [{ acquired }] = await observer<[{ acquired: boolean }]>`
        select pg_try_advisory_lock(hashtextextended(${firstKey}, 0)) as acquired
      `;
      expect(acquired).toBe(true);
      await observer`select pg_advisory_unlock(hashtextextended(${firstKey}, 0))`;
      expect(calls).toBe(0);
      await observer`select pg_advisory_unlock(hashtextextended(${heldKey}, 0))`;
      reserved.release();
      reserved = undefined;
      reservation = undefined;
      expect(await waiter).toEqual({ status: "fulfilled", value: undefined });
      expect(calls).toBe(1);
    } finally {
      try {
        await observer`select pg_advisory_unlock_all()`;
        await cancelWaiters(observer, applicationName);
        // Also release a reservation whose observation timed out during RED.
        (reserved ?? (await reservation))?.release();
        await waiter;
      } finally {
        await Promise.all([client.end(), observer.end()]);
      }
    }
  });

  it("retains locks throughout callback work and cleans up in reverse order after failure", async () => {
    const client = postgres(testUrl, { max: 1 });
    const observer = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const globalKey = actionLockKey.settings();
    const firstKey = `a:${randomUUID()}`;
    const lastKey = `z:${randomUUID()}`;
    const entered = deferred();
    const release = deferred();
    const failure = new Error("callback failure after acquiring all keys");
    const unlocked: string[] = [];
    const action = settled(
      withActionLocks(
        db,
        [lastKey, globalKey, firstKey, lastKey],
        async (lockedDb) => {
          expect(
            (await lockedDb.execute(sql`show lock_timeout`))[0]?.lock_timeout,
          ).toBe("0");
          entered.resolve();
          await release.promise;
          throw failure;
        },
        {
          async unlock(key, unlock) {
            unlocked.push(key);
            if (key === lastKey) throw new Error("injected unlock failure");
            await unlock();
          },
        },
      ),
    );
    try {
      expect(await beforeDeadline(entered.promise.then(() => true))).toBe(true);
      // The acquisition wait limit must never become a lock-holding limit
      // once callback work has started.
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (const key of [globalKey, firstKey, lastKey]) {
        const [{ acquired }] = await observer<[{ acquired: boolean }]>`
          select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
        `;
        expect(acquired).toBe(false);
      }
      release.resolve();
      expect(await action).toEqual({ status: "rejected", reason: failure });
      expect(unlocked).toEqual([lastKey, firstKey, globalKey]);
      for (const key of [globalKey, firstKey, lastKey]) {
        const [{ acquired }] = await observer<[{ acquired: boolean }]>`
          select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
        `;
        expect(acquired).toBe(true);
      }
      expect((await client`show lock_timeout`)[0]?.lock_timeout).toBe("0");
    } finally {
      release.resolve();
      await observer`select pg_advisory_unlock_all()`;
      await action;
      await client.end();
      await observer.end();
    }
  });

  it("still retries only the configured number of busy global acquisitions", async () => {
    let acquisitions = 0;
    const client = postgres(testUrl, {
      max: 1,
      debug: (_connection, query) => {
        if (query.includes("pg_try_advisory_lock")) acquisitions += 1;
      },
    });
    const observer = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const globalKey = actionLockKey.settings();
    let callbacks = 0;
    try {
      await observer`select pg_advisory_lock(hashtextextended(${globalKey}, 0))`;
      await expect(
        withActionLocks(
          db,
          [globalKey],
          async () => {
            callbacks += 1;
          },
          { globalAttempts: 3, globalRetryDelayMs: 0 },
        ),
      ).rejects.toBeInstanceOf(ActionLockBusyError);
      expect(acquisitions).toBe(3);
      expect(callbacks).toBe(0);
      await observer`select pg_advisory_unlock_all()`;
      expect(
        await withActionLocks(db, [globalKey], async () => "available"),
      ).toBe("available");
    } finally {
      await observer`select pg_advisory_unlock_all()`;
      await client.end();
      await observer.end();
    }
  });

  it("propagates statement cancellation during acquisition and restores session timeout", async () => {
    const client = postgres(testUrl, {
      max: 1,
      connection: { lock_timeout: 3_000, statement_timeout: 30 },
    });
    const observer = postgres(testUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const key = actionLockKey.contact(randomUUID());
    let calls = 0;
    let action: Promise<PromiseSettledResult<void>> | undefined;
    try {
      await observer`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      action = settled(
        withActionLocks(db, [key], async () => {
          calls += 1;
        }),
      );
      expect(await beforeDeadline(action)).toMatchObject({
        status: "rejected",
        reason: { code: "57014" },
      });
      expect(calls).toBe(0);
      expect((await client`show lock_timeout`)[0]?.lock_timeout).toBe("3s");
    } finally {
      await observer`select pg_advisory_unlock_all()`;
      await action;
      await client.end();
      await observer.end();
    }
  });
});
