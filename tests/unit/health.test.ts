import { describe, expect, it } from "vitest";

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
});
