import { describe, expect, it } from "vitest";

import {
  cookieValue,
  createOperatorSession,
  operatorCookieSecure,
  safeOperatorRedirect,
  verifyCsrfToken,
  verifyOperatorCredentials,
  verifyOperatorSession,
} from "@/lib/operator-auth";

const environment = {
  OPERATOR_EMAIL: "operator@example.com",
  OPERATOR_PASSWORD: "correct horse battery staple",
  SESSION_SECRET: "a-session-secret-that-is-at-least-32-bytes-long",
};

describe("operator session", () => {
  it("checks the configured email and password without accepting partial credentials", () => {
    expect(
      verifyOperatorCredentials(
        "operator@example.com",
        "correct horse battery staple",
        environment,
      ),
    ).toBe(true);
    expect(
      verifyOperatorCredentials(
        "operator@example.com",
        "correct horse battery",
        environment,
      ),
    ).toBe(false);
    expect(
      verifyOperatorCredentials(
        "other@example.com",
        "correct horse battery staple",
        environment,
      ),
    ).toBe(false);
  });

  it("signs a bounded session and rejects tampering or expiry", () => {
    const issuedAt = new Date("2026-08-12T10:00:00.000Z");
    const session = createOperatorSession(environment, {
      now: issuedAt,
      ttlSeconds: 3_600,
      csrfToken: "csrf-test-token-with-enough-entropy",
    });

    expect(
      verifyOperatorSession(session.token, environment, {
        now: new Date("2026-08-12T10:30:00.000Z"),
      }),
    ).toMatchObject({
      email: "operator@example.com",
      csrfToken: "csrf-test-token-with-enough-entropy",
    });
    expect(
      verifyOperatorSession(`${session.token}tampered`, environment, {
        now: new Date("2026-08-12T10:30:00.000Z"),
      }),
    ).toBeNull();
    expect(
      verifyOperatorSession(session.token, environment, {
        now: new Date("2026-08-12T11:00:01.000Z"),
      }),
    ).toBeNull();
  });

  it("keeps operator identity out of the client-visible session payload", () => {
    const { token } = createOperatorSession(environment, {
      now: new Date("2026-08-12T10:00:00.000Z"),
      csrfToken: "csrf-test-token-with-enough-entropy",
    });
    const encodedPayload = token.slice(0, token.lastIndexOf("."));
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");

    expect(payload).not.toContain("operator@example.com");
    expect(JSON.parse(payload)).toMatchObject({ subject: "operator" });
  });

  it("requires an exact csrf token from the authenticated session", () => {
    const session = createOperatorSession(environment, {
      now: new Date("2026-08-12T10:00:00.000Z"),
      csrfToken: "csrf-test-token-with-enough-entropy",
    });
    const verified = verifyOperatorSession(session.token, environment, {
      now: new Date("2026-08-12T10:01:00.000Z"),
    });

    expect(verified).not.toBeNull();
    expect(
      verifyCsrfToken(verified!, "csrf-test-token-with-enough-entropy"),
    ).toBe(true);
    expect(
      verifyCsrfToken(verified!, "csrf-test-token-with-enough-entropx"),
    ).toBe(false);
    expect(verifyCsrfToken(verified!, null)).toBe(false);
  });

  it("limits post-login redirects to local application paths", () => {
    expect(safeOperatorRedirect("/prospects?status=ready")).toBe(
      "/prospects?status=ready",
    );
    expect(safeOperatorRedirect("https://attacker.example/path")).toBe("/");
    expect(safeOperatorRedirect("//attacker.example/path")).toBe("/");
    expect(safeOperatorRedirect("/\\attacker.example/path")).toBe("/");
    expect(safeOperatorRedirect(null)).toBe("/");
  });

  it("treats a malformed cookie encoding as absent", () => {
    const request = new Request("http://localhost", {
      headers: { cookie: "broken=%E0%A4%A; valid=value" },
    });

    expect(cookieValue(request, "broken")).toBeNull();
    expect(cookieValue(request, "valid")).toBe("value");
  });

  it("honors trusted HTTPS forwarding and an explicit local cookie override", () => {
    const forwarded = new Request("http://internal:3000", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(operatorCookieSecure(forwarded, {})).toBe(true);
    expect(
      operatorCookieSecure(forwarded, { OPERATOR_COOKIE_SECURE: "false" }),
    ).toBe(false);
  });
});
