import { expect, request as playwrightRequest, test } from "@playwright/test";

test("protects the operator UI and issues a hardened session cookie", async () => {
  const anonymous = await playwrightRequest.newContext({
    baseURL: "http://127.0.0.1:3000",
  });
  const protectedResponse = await anonymous.get("/prospects", {
    maxRedirects: 0,
  });
  expect(protectedResponse.status()).toBe(307);
  expect(protectedResponse.headers().location).toBe("/login?next=%2Fprospects");

  const invalidLogin = await anonymous.post("/api/operator/session", {
    form: {
      intent: "login",
      email: "operator@example.com",
      password: "wrong password",
      next: "/prospects",
    },
    maxRedirects: 0,
  });
  expect(invalidLogin.status()).toBe(303);
  expect(invalidLogin.headers()["set-cookie"]).toBeUndefined();

  const login = await anonymous.post("/api/operator/session", {
    form: {
      intent: "login",
      email: "operator@example.com",
      password: "correct horse battery staple",
      next: "/prospects",
    },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  expect(new URL(login.headers().location!).pathname).toBe("/prospects");
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
  expect(new URL(unsafeReturn.headers().location!).origin).toBe(
    "http://localhost:3000",
  );

  const csrfFailure = await anonymous.post(
    "/api/operator/commands/add-suppression",
    { form: { scope: "email", value: "blocked@example.com" } },
  );
  expect(csrfFailure.status()).toBe(403);
  await anonymous.dispose();
});

test("lets the authenticated operator remove a manual suppression with an audit justification", async () => {
  const operator = await playwrightRequest.newContext({
    baseURL: "http://127.0.0.1:3000",
  });
  await operator.post("/api/operator/session", {
    form: {
      intent: "login",
      email: "operator@example.com",
      password: "correct horse battery staple",
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
