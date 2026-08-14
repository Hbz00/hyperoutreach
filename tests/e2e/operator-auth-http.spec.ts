import { expect, request as playwrightRequest, test } from "@playwright/test";

import {
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
} from "./support/environment";

test("protects the operator UI and issues a hardened session cookie", async ({
  baseURL,
}) => {
  const anonymous = await playwrightRequest.newContext({
    baseURL,
  });
  const protectedResponse = await anonymous.get("/prospects", {
    maxRedirects: 0,
  });
  expect(protectedResponse.status()).toBe(307);
  expect(protectedResponse.headers().location).toBe("/login?next=%2Fprospects");

  const invalidLogin = await anonymous.post("/api/operator/session", {
    form: {
      intent: "login",
      email: E2E_OPERATOR_EMAIL,
      password: "wrong password",
      next: "/prospects",
    },
    maxRedirects: 0,
  });
  expect(invalidLogin.status()).toBe(303);
  expect(invalidLogin.headers().location).toBe(
    "/login?error=invalid_credentials&next=%2Fprospects",
  );
  expect(invalidLogin.headers()["set-cookie"]).toBeUndefined();

  const login = await anonymous.post("/api/operator/session", {
    form: {
      intent: "login",
      email: E2E_OPERATOR_EMAIL,
      password: E2E_OPERATOR_PASSWORD,
      next: "/prospects",
    },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  // A relative redirect is essential here. Next may expose the request URL as
  // `localhost` even when the browser connected to `127.0.0.1`; an absolute
  // redirect would change hosts and strand the host-only session cookie.
  expect(login.headers().location).toBe("/prospects");
  expect(login.headers()["set-cookie"]).toContain("HttpOnly");
  expect(login.headers()["set-cookie"]).toContain("SameSite=Lax");

  const page = await anonymous.get("/prospects");
  expect(page.status()).toBe(200);
  const html = await page.text();
  expect(html).toContain("Prospects");
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();

  const unsafeReturn = await anonymous.post(
    "/api/operator/commands/stop-enrollment",
    {
      form: {
        csrf: csrf!,
        enrollmentId: "00000000-0000-0000-0000-000000000000",
        returnTo: "https://attacker.example/steal",
      },
      maxRedirects: 0,
    },
  );
  expect(unsafeReturn.headers().location).toMatch(/^\/\?notice=/);
  expect(unsafeReturn.headers().location).not.toContain("attacker.example");

  const csrfFailure = await anonymous.post(
    "/api/operator/commands/add-suppression",
    { form: { scope: "email", value: "blocked@example.com" } },
  );
  expect(csrfFailure.status()).toBe(403);
  await anonymous.dispose();
});

test("lets the authenticated operator remove a manual suppression with an audit justification", async ({
  baseURL,
}) => {
  const operator = await playwrightRequest.newContext({
    baseURL,
  });
  await operator.post("/api/operator/session", {
    form: {
      intent: "login",
      email: E2E_OPERATOR_EMAIL,
      password: E2E_OPERATOR_PASSWORD,
      next: "/settings",
    },
  });
  const csrf = (await (await operator.get("/settings")).text()).match(
    /name="csrf" value="([^"]+)"/,
  )?.[1];
  expect(csrf).toBeTruthy();
  const target = `temporary-${crypto.randomUUID()}@example.com`;
  await operator.post("/api/operator/commands/add-suppression", {
    form: { csrf: csrf!, scope: "email", value: target, reason: "manual" },
  });
  const withSuppression = await (await operator.get("/settings")).text();
  expect(withSuppression).toContain(target);
  const row = withSuppression
    .split("<tr")
    .find((candidate) => candidate.includes(target));
  const suppressionId = row?.match(/name="id" value="([^"]+)"/)?.[1];
  expect(suppressionId).toBeTruthy();

  await operator.post("/api/operator/commands/remove-suppression", {
    form: {
      csrf: csrf!,
      id: suppressionId!,
      justification: "Operator test cleanup",
    },
  });
  expect(await (await operator.get("/settings")).text()).not.toContain(target);
  await operator.dispose();
});
