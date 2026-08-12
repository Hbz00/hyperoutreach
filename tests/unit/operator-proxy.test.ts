import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/lib/operator-auth";
import { applyOperatorProxy } from "@/proxy";

const environment = {
  OPERATOR_EMAIL: "operator@example.com",
  OPERATOR_PASSWORD: "correct horse battery staple",
  SESSION_SECRET: "a-session-secret-that-is-at-least-32-bytes-long",
  OPERATOR_API_TOKEN: "an-api-token-that-is-at-least-32-bytes-long",
};

describe("operator proxy", () => {
  it("lets a valid browser session reach protected pages", () => {
    const { token } = createOperatorSession(environment);
    const request = new NextRequest("http://localhost/prospects", {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    });

    const response = applyOperatorProxy(request, environment);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects an anonymous page request to login with a bounded next path", () => {
    const response = applyOperatorProxy(
      new NextRequest("http://localhost/prospects?status=active"),
      environment,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?next=%2Fprospects%3Fstatus%3Dactive",
    );
  });

  it("lets the scheduler bearer token reach its protected route", () => {
    const response = applyOperatorProxy(
      new NextRequest("http://localhost/api/internal/workflows/reconcile", {
        method: "POST",
        headers: { authorization: `Bearer ${environment.OPERATOR_API_TOKEN}` },
      }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects an invalid bearer token at protected API routes", async () => {
    const response = applyOperatorProxy(
      new NextRequest("http://localhost/api/internal/workflows/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer invalid" },
      }),
      environment,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
