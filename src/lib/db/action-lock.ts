import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";

export const actionLockKey = {
  campaign: (id: string) => `campaign:${id}`,
  enrollment: (id: string) => `enrollment:${id}`,
  contact: (id: string) => `contact:${id}`,
  mailbox: (id: string | null) => `mailbox:${id ?? "local-mock"}`,
  recipient: (email: string) => `recipient:${email}`,
  domain: (domain: string) => `domain:${domain}`,
  settings: () => "settings:singleton",
} as const;

export class ActionLockBusyError extends Error {
  constructor() {
    super("Global action lock is busy");
    this.name = "ActionLockBusyError";
  }
}

export function isActionLockBusy(error: unknown): boolean {
  return error instanceof ActionLockBusyError;
}

// Only facades passed to an active callback may reuse their caller's session.
// PostgreSQL counts reentrant acquisitions; each scope unlocks its own count.
const reservedSessions = new WeakMap<AppDatabase, postgres.ReservedSql>();

export async function withActionLocks<T>(
  db: AppDatabase,
  rawKeys: readonly string[],
  action: (lockedDb: AppDatabase) => Promise<T>,
  options: {
    unlock?: (key: string, unlock: () => Promise<void>) => Promise<void>;
    globalAttempts?: number;
    globalRetryDelayMs?: number;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.globalAttempts ?? 1);
  if (attempts > 1) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let actionStarted = false;
      try {
        return await withActionLocks(
          db,
          rawKeys,
          async (lockedDb) => {
            actionStarted = true;
            return action(lockedDb);
          },
          { ...options, globalAttempts: 1 },
        );
      } catch (error) {
        if (actionStarted || !isActionLockBusy(error) || attempt === attempts) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, options.globalRetryDelayMs ?? 25),
        );
      }
    }
    throw new ActionLockBusyError();
  }
  const globalKey = actionLockKey.settings();
  const uniqueKeys = [...new Set(rawKeys)];
  const hasGlobalKey = uniqueKeys.includes(globalKey);
  const keys = uniqueKeys.filter((key) => key !== globalKey).sort();
  while (true) {
    const outerConnection = reservedSessions.get(db);
    const connection = outerConnection ?? (await db.$client.reserve());
    let lockedDb = db;
    const acquired: string[] = [];
    try {
      // postgres.js reserved sessions intentionally omit pool configuration,
      // while Drizzle needs its parser/serializer registry to construct a
      // session-bound database facade.
      if (!outerConnection) {
        Object.assign(connection, { options: db.$client.options });
        lockedDb = drizzle(connection, { schema }) as AppDatabase;
        reservedSessions.set(lockedDb, connection);
        Object.assign(lockedDb, {
          transaction: async <R>(
            callback: (
              tx: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0],
            ) => Promise<R>,
          ): Promise<R> => {
            await connection.unsafe("begin");
            try {
              const result = await callback(
                lockedDb as unknown as Parameters<
                  Parameters<AppDatabase["transaction"]>[0]
                >[0],
              );
              await connection.unsafe("commit");
              return result;
            } catch (error) {
              await connection.unsafe("rollback");
              throw error;
            }
          },
        });
      }
      if (hasGlobalKey) {
        const [{ acquired: globalAcquired }] = await connection<
          [{ acquired: boolean }]
        >`select pg_try_advisory_lock(hashtextextended(${globalKey}, 0)) as acquired`;
        if (!globalAcquired) throw new ActionLockBusyError();
        acquired.push(globalKey);
      }
      let acquisitionTimedOut = false;
      if (keys.length > 0) {
        // Top-level retries return pool capacity for a holder's dependencies.
        // Nested retries retain the caller's session and its outer locks.
        for (const key of keys) {
          try {
            // An implicit transaction rolls back SET LOCAL even on query
            // cancellation. Restore explicitly in the same statement too,
            // so a successful acquisition inside a caller transaction keeps
            // that transaction's previous timeout. CTE dependencies enforce
            // capture -> configure -> acquire -> restore execution order.
            await connection`
              with previous_lock_timeout as materialized (
                select current_setting('lock_timeout') as timeout
              ), bounded_lock_timeout as materialized (
                select set_config('lock_timeout', '100ms', true)
                from previous_lock_timeout
              ), acquired_action_lock as materialized (
                select pg_advisory_lock(hashtextextended(${key}, 0))
                from bounded_lock_timeout
              )
              select set_config('lock_timeout', previous_lock_timeout.timeout, true)
              from acquired_action_lock cross join previous_lock_timeout
            `;
            acquired.push(key);
          } catch (error) {
            if (
              !(error instanceof postgres.PostgresError) ||
              error.code !== "55P03"
            ) {
              throw error;
            }
            acquisitionTimedOut = true;
            break;
          }
        }
      }
      if (!acquisitionTimedOut) {
        return await action(lockedDb);
      }
    } finally {
      let cleanupFailed = false;
      let sessionClean = false;
      try {
        for (const key of acquired.reverse()) {
          let unlocked = false;
          const unlock = async () => {
            if (unlocked) return;
            await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
            unlocked = true;
          };
          try {
            await (options.unlock ? options.unlock(key, unlock) : unlock());
          } catch {
            cleanupFailed = true;
          } finally {
            // Nested scopes must not unlock_all: that would release the
            // caller's still-active locks. Retry only this acquisition when
            // an injected cleanup hook did not perform its unlock.
            if (outerConnection && !unlocked) {
              try {
                await unlock();
              } catch {
                cleanupFailed = true;
              }
            }
          }
        }
      } finally {
        try {
          if (!outerConnection) {
            // Cancellation does not close a PostgreSQL session or release its
            // advisory locks. Await an acknowledged cleanup before returning
            // this connection to the pool; replay only cleanup, never action.
            while (true) {
              try {
                await connection`select pg_advisory_unlock_all()`;
                sessionClean = true;
                break;
              } catch (error) {
                if (
                  !(error instanceof postgres.PostgresError) ||
                  error.code !== "57014"
                ) {
                  throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
            }
          }
        } catch {
          cleanupFailed = true;
        } finally {
          if (!outerConnection) {
            reservedSessions.delete(lockedDb);
            // A broken reserved connection is removed by postgres.js onclose.
            // Calling release on it can reinsert it into the ready pool. An
            // unconfirmed healthy session must likewise remain quarantined.
            if (sessionClean) connection.release();
          }
        }
      }
      if (cleanupFailed) {
        // Preserve the action result, including after connection loss. A
        // persistently cancelled cleanup waits with its reservation retained.
      }
    }
    // Only acquisition reaches this retry; callback results and errors return
    // above after releasing all keys and restoring the reserved session.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
