import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    clientCreations: 0,
    fakeClient: Object.assign(() => Promise.resolve([]), { end: vi.fn() }),
  };
  return Object.assign(state, {
    driver: Object.assign(
      () => {
        state.clientCreations += 1;
        return state.fakeClient;
      },
      { hyperoutreachReservationPatch: undefined as string | undefined },
    ),
  });
});

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({
  default: mocks.driver,
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: unknown) => ({ client }),
}));

describe("server database connection", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.clientCreations = 0;
    mocks.driver.hyperoutreachReservationPatch =
      "hyperoutreach-postgres-3.4.9-v1";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://user:secret@localhost/app");
    delete (
      globalThis as typeof globalThis & { hyperoutreachPostgres?: unknown }
    ).hyperoutreachPostgres;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (
      globalThis as typeof globalThis & { hyperoutreachPostgres?: unknown }
    ).hyperoutreachPostgres;
  });

  it("reuses one process-wide SQL client in production", async () => {
    const { getDatabase, getSqlClient } = await import("@/lib/db/client");

    expect(getSqlClient()).toBe(getSqlClient());
    getDatabase();
    getDatabase();

    expect(mocks.clientCreations).toBe(1);
  });

  it.each([undefined, "unknown-repair"])(
    "refuses an unverified imported driver before reusing a cached client (%s)",
    async (revision) => {
      mocks.driver.hyperoutreachReservationPatch = revision;
      (
        globalThis as typeof globalThis & { hyperoutreachPostgres?: unknown }
      ).hyperoutreachPostgres = mocks.fakeClient;
      const { getSqlClient } = await import("@/lib/db/client");

      expect(getSqlClient).toThrow(/npm run postinstall/);
      expect(mocks.clientCreations).toBe(0);
    },
  );
});
