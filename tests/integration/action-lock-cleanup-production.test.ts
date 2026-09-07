import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, it } from "vitest";

import { withActionLocks } from "@/lib/db/action-lock";
import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";

const { testUrl } = resolveDatabaseUrls(process.env);

it.each(["return", "throw"] as const)(
  "cleans up after native PostgreSQL cancellation without replaying a callback that will %s",
  async (outcome) => {
    const observer = postgres(testUrl, { max: 1 });
    const key = `cleanup-cancellation:${randomUUID()}`;
    const callbackError = new Error("original callback failure");
    let pid = 0;
    let armed = false;
    let cancellations: Promise<unknown>[] = [];
    const cleanupErrors: string[] = [];
    const client = postgres(testUrl, {
      max: 1,
      debug: (_id, query) => {
        if (armed && query === "select pg_advisory_unlock_all()") {
          armed = false;
          cancellations.push(
            observer`select pg_cancel_backend(${pid})`.then(() => {}),
          );
        }
      },
    });
    const reserve = client.reserve.bind(client);
    client.reserve = async () => {
      const connection = await reserve();
      // Observe the real error without changing the statement, result, or
      // cancellation timing. Cancellation must be demonstrated, not assumed.
      return new Proxy(connection, {
        apply(target, thisArg, args) {
          const query = Reflect.apply(target, thisArg, args);
          if (args[0]?.join("") !== "select pg_advisory_unlock_all()")
            return query;
          return query.catch((error: unknown) => {
            if (error instanceof postgres.PostgresError)
              cleanupErrors.push(error.code);
            throw error;
          });
        },
      });
    };
    const db = drizzle(client, { schema });
    let callbacks = 0;
    let iterations = 0;
    try {
      [{ pid }] = await client`select pg_backend_pid() as pid`;
      await observer`select 1`;
      // A cancel sent over another connection races a very short statement.
      // Repeat boundedly until PostgreSQL confirms an actual 57014; inability
      // to hit the failure path is a failed test, never a passing assertion.
      for (iterations = 1; iterations <= 2000; iterations += 1) {
        armed = true;
        const action = withActionLocks(
          db,
          [key],
          async () => {
            callbacks += 1;
            if (outcome === "throw") throw callbackError;
            return "original result";
          },
          {
            unlock: async () => {
              throw new Error("individual unlock failed before execution");
            },
          },
        );
        if (outcome === "throw")
          await expect(action).rejects.toBe(callbackError);
        else await expect(action).resolves.toBe("original result");
        await Promise.all(cancellations);
        cancellations = [];
        const [{ locks }] = await observer<[{ locks: number }]>`
          select count(*)::int as locks from pg_locks
          where pid = ${pid} and locktype = 'advisory'
        `;
        expect(locks, "no acquired lock may escape to the shared pool").toBe(0);
        expect(callbacks).toBe(iterations);
        if (cleanupErrors.includes("57014")) break;
      }
      expect(cleanupErrors).toContain("57014");
      expect(iterations).toBeLessThanOrEqual(2000);
      const [{ acquired }] = await observer<[{ acquired: boolean }]>`
        select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
      `;
      expect(acquired).toBe(true);
      const [{ reusedPid }] = await client<[{ reusedPid: number }]>`
        select pg_backend_pid() as "reusedPid"
      `;
      expect(reusedPid).toBe(pid);
      expect(callbacks).toBe(iterations);
    } finally {
      armed = false;
      await Promise.allSettled(cancellations);
      await observer`select pg_advisory_unlock_all()`;
      await client.end({ timeout: 2 });
      try {
        const [{ locks }] = await observer<[{ locks: number }]>`
          select count(*)::int as locks from pg_locks
          where pid = ${pid} and locktype = 'advisory'
        `;
        expect(locks).toBe(0);
      } finally {
        await observer.end({ timeout: 2 });
      }
    }
  },
  20_000,
);

it.each(["esm", "cjs"])(
  "refuses a closed or stale reserved handle and recovers pool capacity (%s)",
  async (entryPoint) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["tests/fixtures/postgres-reservation-loss.mjs", entryPoint],
      { env: { ...process.env, TEST_DATABASE_URL: testUrl }, timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      entryPoint,
      locks: 0,
      replaced: true,
    });
  },
);

it.each([
  ["esm", "1"],
  ["cjs", "1"],
  ["esm", "100"],
  ["cjs", "100"],
  ["esm", "backpressure"],
  ["cjs", "backpressure"],
])(
  "keeps transaction ownership at the native pipeline boundary (%s, %s)",
  async (entryPoint, pipeline) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "tests/fixtures/postgres-transaction-boundary.mjs",
        entryPoint!,
        pipeline!,
      ],
      { env: { ...process.env, TEST_DATABASE_URL: testUrl }, timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      entryPoint,
      pipeline: pipeline === "backpressure" ? "backpressure" : Number(pipeline),
      callbackCount: 1,
      state: "idle",
      unhandled: [],
    });
  },
);
