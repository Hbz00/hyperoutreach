import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientCreations: 0,
  fakeClient: Object.assign(() => Promise.resolve([]), { end: vi.fn() }),
}));

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({
  default: () => {
    mocks.clientCreations += 1;
    return mocks.fakeClient;
  },
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (client: unknown) => ({ client }),
}));

describe("server database connection", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.clientCreations = 0;
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
});
