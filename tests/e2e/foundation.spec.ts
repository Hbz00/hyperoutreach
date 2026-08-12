import { expect, request as playwrightRequest, test } from "@playwright/test";

import {
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
} from "./support/environment";

test("serves the authenticated product shell and public database health", async () => {
  const context = await playwrightRequest.newContext({
    baseURL: "http://127.0.0.1:3000",
  });
  const health = await context.get("/api/health");
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toEqual({
    status: "ok",
    database: "reachable",
  });

  const anonymous = await context.get("/", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);

  await context.post("/api/operator/session", {
    form: {
      intent: "login",
      email: E2E_OPERATOR_EMAIL,
      password: E2E_OPERATOR_PASSWORD,
      next: "/",
    },
  });
  const dashboard = await context.get("/");
  expect(dashboard.status()).toBe(200);
  const html = await dashboard.text();
  expect(html).toContain("Campaign state at a glance");
  expect(html).toContain("Prospects");
  expect(html).toContain("Review queue");
  expect(html).toContain("Inbox");
  expect(html).not.toContain("SESSION_SECRET");
  await context.dispose();
});
