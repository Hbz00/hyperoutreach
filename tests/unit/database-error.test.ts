import { describe, expect, it } from "vitest";

import { sanitizeDatabaseError } from "@/lib/db/sanitize-error";

describe("database error sanitization", () => {
  it("keeps actionable SQLSTATE, name, and message without database URLs", () => {
    const databaseUrl =
      "postgresql://operator:super-secret@database.internal:5432/outreach";
    const result = sanitizeDatabaseError(
      {
        name: "PostgresError",
        code: "23505",
        message: `duplicate key while connecting to ${databaseUrl}`,
        query: "insert into mailbox_connections (encrypted_refresh_token)",
      },
      [databaseUrl],
    );

    expect(result).toContain("PostgresError");
    expect(result).toContain("SQLSTATE 23505");
    expect(result).toContain("duplicate key");
    expect(result).not.toContain("postgresql://");
    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("encrypted_refresh_token");
  });

  it("redacts credential-like fragments from ordinary error messages", () => {
    const result = sanitizeDatabaseError(
      new Error("authentication failed password=hunter2 token=abc123"),
    );

    expect(result).toBe(
      "Error: authentication failed password=[REDACTED] token=[REDACTED]",
    );
  });

  it("returns a stable message for non-error values", () => {
    expect(sanitizeDatabaseError({ payload: "untrusted" })).toBe(
      "DatabaseError: Unknown database error",
    );
  });
});
