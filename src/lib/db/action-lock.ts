import { drizzle } from "drizzle-orm/postgres-js";

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
      try {
        return await withActionLocks(db, rawKeys, action, {
          ...options,
          globalAttempts: 1,
        });
      } catch (error) {
        if (!isActionLockBusy(error) || attempt === attempts) throw error;
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
  const connection = await db.$client.reserve();
  const acquired: string[] = [];
  try {
    // postgres.js reserved sessions intentionally omit pool configuration,
    // while Drizzle needs its parser/serializer registry to construct a
    // session-bound database facade.
    Object.assign(connection, { options: db.$client.options });
    const lockedDb = drizzle(connection, { schema }) as AppDatabase;
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
    if (hasGlobalKey) {
      const [{ acquired: globalAcquired }] = await connection<
        [{ acquired: boolean }]
      >`select pg_try_advisory_lock(hashtextextended(${globalKey}, 0)) as acquired`;
      if (!globalAcquired) throw new ActionLockBusyError();
      acquired.push(globalKey);
    }
    for (const key of keys) {
      await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      acquired.push(key);
    }
    return await action(lockedDb);
  } finally {
    let cleanupFailed = false;
    try {
      for (const key of acquired.reverse()) {
        try {
          const unlock = async () => {
            await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
          };
          await (options.unlock ? options.unlock(key, unlock) : unlock());
        } catch {
          cleanupFailed = true;
        }
      }
    } finally {
      try {
        await connection`select pg_advisory_unlock_all()`;
      } catch {
        cleanupFailed = true;
      } finally {
        connection.release();
      }
    }
    if (cleanupFailed) {
      // postgres.js discards a broken reserved session. unlock_all is the
      // final defense for a healthy one; never obscure the action result.
    }
  }
}
