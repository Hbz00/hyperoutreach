import { describe, expect, it } from "vitest";

import {
  assertDisposableDatabaseName,
  assertDisposableTestDatabase,
  resolveDatabaseUrls,
} from "@/lib/db/test-database";

describe("disposable integration database configuration", () => {
  it("defaults to a database separate from the application database", () => {
    expect(resolveDatabaseUrls({})).toEqual({
      applicationUrl:
        "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach",
      testUrl:
        "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach_test",
    });
  });

  it("rejects the exact application database URL", () => {
    const url = "postgresql://user:password@localhost:5432/application";
    expect(() => assertDisposableTestDatabase(url, url)).toThrow(
      "must not target the application database",
    );
  });

  it("rejects the application database name even through another URL", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgresql://user:password@localhost:5432/application",
        "postgresql://other:secret@127.0.0.1:55432/application",
      ),
    ).toThrow("must use a different database name");
  });

  it("requires an explicitly test-named database", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgresql://user:password@localhost:5432/application",
        "postgresql://user:password@localhost:5432/disposable",
      ),
    ).toThrow("must end with _test");
  });

  it("accepts a separate test database", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgresql://user:password@localhost:5432/application",
        "postgresql://user:password@localhost:5432/application_test",
      ),
    ).not.toThrow();
  });

  it("only allows explicitly disposable names for standalone test provisioning", () => {
    expect(() =>
      assertDisposableDatabaseName(
        "postgresql://user:password@localhost:5432/hyperoutreach_e2e_test",
      ),
    ).not.toThrow();
    expect(() =>
      assertDisposableDatabaseName(
        "postgresql://user:password@localhost:5432/hyperoutreach",
      ),
    ).toThrow("must end with _test");
  });
});
