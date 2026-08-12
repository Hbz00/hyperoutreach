import { describe, expect, it } from "vitest";

import { isPublicOperatorPath } from "@/lib/operator-route-policy";

describe("operator route policy", () => {
  it.each([
    "/login",
    "/api/health",
    "/api/webhooks/microsoft",
    "/api/integrations/microsoft/callback",
    "/_next/static/chunk.js",
    "/favicon.ico",
  ])("allows the explicitly public path %s", (path) => {
    expect(isPublicOperatorPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/prospects",
    "/campaigns",
    "/review",
    "/inbox",
    "/settings",
    "/api/integrations/microsoft/authorize",
    "/api/internal/workflows/reconcile",
  ])("protects %s", (path) => {
    expect(isPublicOperatorPath(path)).toBe(false);
  });
});
