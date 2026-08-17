import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_OVERRIDES = {
  OPERATOR_EMAIL: "operator@lockout.example",
  OPERATOR_PASSWORD: "at-least-twelve-characters",
  SESSION_SECRET: "s".repeat(32),
};

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of Object.keys(ENV_OVERRIDES) as Array<
    keyof typeof ENV_OVERRIDES
  >) {
    originalEnv[key] = process.env[key];
    process.env[key] = ENV_OVERRIDES[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { POST } = await import("@/app/api/operator/session/route");

function login(
  email: string,
  password: string,
  source: string,
): Promise<Response> {
  const body = new URLSearchParams({ email, password });
  return POST(
    new Request("http://127.0.0.1/api/operator/session", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Written by the client, which is exactly why the per-source window
        // cannot be the only bound — and why an attacker never meets it.
        "x-forwarded-for": source,
      },
      body: body.toString(),
    }),
  );
}

// The throttle exists to bound guessing. It must not become a way for an
// unauthenticated stranger to keep the only operator out of their own
// installation: the global window is shared by every source precisely because
// the per-source key is a header the client writes, so filling it takes one
// minute of wrong passwords from rotating addresses.
describe("signing in while the login throttle is full", () => {
  it("still admits the operator's correct password", async () => {
    // Past the global limit of 100 in the window, from addresses that each
    // stay under the per-source limit of 8.
    for (let attempt = 0; attempt < 110; attempt += 1) {
      const refused = await login(
        ENV_OVERRIDES.OPERATOR_EMAIL,
        "wrong-password",
        `203.0.113.${attempt % 200}`,
      );
      expect([303, 429]).toContain(refused.status);
    }
    // The window is genuinely full: another guess is refused.
    const guess = await login(
      ENV_OVERRIDES.OPERATOR_EMAIL,
      "still-wrong-password",
      "198.51.100.7",
    );
    expect(guess.status).toBe(429);

    const admitted = await login(
      ENV_OVERRIDES.OPERATOR_EMAIL,
      ENV_OVERRIDES.OPERATOR_PASSWORD,
      "198.51.100.7",
    );

    expect(admitted.status).toBe(303);
    expect(admitted.headers.get("set-cookie")).toContain(
      "hyperoutreach_session=",
    );
  });

  it("clears the shared window once the operator has signed in", async () => {
    for (let attempt = 0; attempt < 110; attempt += 1) {
      await login(
        ENV_OVERRIDES.OPERATOR_EMAIL,
        "wrong-password",
        `192.0.2.${attempt % 200}`,
      );
    }
    await login(
      ENV_OVERRIDES.OPERATOR_EMAIL,
      ENV_OVERRIDES.OPERATOR_PASSWORD,
      "198.51.100.9",
    );

    // A wrong password is answered as a wrong password again, not as a
    // leftover refusal from a burst the operator has already outlived.
    const afterwards = await login(
      ENV_OVERRIDES.OPERATOR_EMAIL,
      "wrong-password",
      "198.51.100.9",
    );

    expect(afterwards.status).toBe(303);
    expect(afterwards.headers.get("location")).toContain("invalid_credentials");
  });
});
