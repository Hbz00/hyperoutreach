import { describe, expect, it, vi } from "vitest";

import { checkDatabaseHealth } from "@/lib/db/health";

describe("database health", () => {
  it("reports a reachable database", async () => {
    await expect(checkDatabaseHealth(async () => [{ ok: 1 }])).resolves.toEqual(
      {
        status: "ok",
        database: "reachable",
      },
    );
  });

  it("does not expose database errors", async () => {
    await expect(
      checkDatabaseHealth(async () => {
        throw new Error("password=super-secret");
      }),
    ).resolves.toEqual({ status: "error", database: "unreachable" });
  });

  it("reports an outdated schema when migrations are pending", async () => {
    await expect(
      checkDatabaseHealth(async () => [{ ok: 1 }], {
        expectedMigrations: 30,
        countAppliedMigrations: async () => 27,
      }),
    ).resolves.toEqual({
      status: "error",
      database: "reachable",
      schema: "outdated",
      appliedMigrations: 27,
      expectedMigrations: 30,
    });
  });

  it("stays healthy when every migration is applied", async () => {
    await expect(
      checkDatabaseHealth(async () => [{ ok: 1 }], {
        expectedMigrations: 30,
        countAppliedMigrations: async () => 30,
      }),
    ).resolves.toEqual({ status: "ok", database: "reachable" });
  });

  it("stays healthy when the database is ahead of the deployed code", async () => {
    // Migrations run before the new build ships, so a database that already
    // carries the next release must not fail the health gate.
    await expect(
      checkDatabaseHealth(async () => [{ ok: 1 }], {
        expectedMigrations: 30,
        countAppliedMigrations: async () => 31,
      }),
    ).resolves.toEqual({ status: "ok", database: "reachable" });
  });

  it("treats a missing migrations table as an empty schema", async () => {
    await expect(
      checkDatabaseHealth(async () => [{ ok: 1 }], {
        expectedMigrations: 30,
        countAppliedMigrations: async () => {
          throw new Error(
            'relation "drizzle.__drizzle_migrations" does not exist',
          );
        },
      }),
    ).resolves.toEqual({
      status: "error",
      database: "reachable",
      schema: "outdated",
      appliedMigrations: 0,
      expectedMigrations: 30,
    });
  });

  it("keeps reporting an unreachable database without probing the schema", async () => {
    const countAppliedMigrations = vi.fn(async () => 30);
    await expect(
      checkDatabaseHealth(
        async () => {
          throw new Error("connection refused");
        },
        { expectedMigrations: 30, countAppliedMigrations },
      ),
    ).resolves.toEqual({ status: "error", database: "unreachable" });
    expect(countAppliedMigrations).not.toHaveBeenCalled();
  });
});
