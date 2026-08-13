import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `route.ts` transitively imports `@/lib/db/client`, which imports the real
// `server-only` package — a hard, unconditional throw outside a Next.js
// `react-server` bundle (see the comment on `smtp-imap-connection-service.ts`
// and its own unit test for the same shadowing trick). `getDatabase()`
// itself is never actually called with a live connection here: every
// assertion below is reached before `connect-smtp-mailbox` would ever touch
// the database (see the route's own `connectSmtpImapMailbox` — its input
// schema is validated, and rejected, before any query or network call).
vi.mock("server-only", () => ({}));

const ENV_OVERRIDES = {
  OPERATOR_EMAIL: "operator@contract.example",
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

// Restored via `afterEach` (not `afterAll`) so a failure partway through one
// test never leaks a fake `SESSION_SECRET` into a sibling test file sharing
// this same `vitest` worker process.
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const { POST } = await import("@/app/api/operator/commands/[command]/route");
const { createOperatorSession, OPERATOR_SESSION_COOKIE } =
  await import("@/lib/operator-auth");

function buildConnectRequest(fields: Record<string, string>): Request {
  const { token, session } = createOperatorSession(process.env);
  const formData = new FormData();
  formData.set("csrf", session.csrfToken);
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  const request = new Request(
    "http://operator.local/api/operator/commands/connect-smtp-mailbox",
    {
      method: "POST",
      body: formData,
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    },
  );
  return request;
}

async function postConnectSmtpMailbox(
  fields: Record<string, string>,
): Promise<{ status: number; notice: string | null }> {
  const response = await POST(buildConnectRequest(fields), {
    params: Promise.resolve({ command: "connect-smtp-mailbox" }),
  });
  const location = response.headers.get("location");
  // `destination()` (route.ts) sets `Location` to a *relative* path
  // (`/settings?notice=...`) via `mutableRedirect` -- resolve it against a
  // base the same way a browser would, `new URL(location)` alone throws on
  // a bare relative path.
  const notice = location
    ? new URL(location, "http://operator.local").searchParams.get("notice")
    : null;
  return { status: response.status, notice };
}

const validFieldsExceptUsername = {
  email: "corentin.sacazes@polytechnique.edu",
  password: "correct-horse-battery-staple",
  imapHost: "imap.example.invalid",
  imapPort: "993",
  imapSecurity: "tls",
  smtpHost: "smtp.example.invalid",
  smtpPort: "587",
  smtpSecurity: "starttls",
};

describe("connect-smtp-mailbox: username must never silently fall back to the email address", () => {
  it("rejects an empty username explicitly (INVALID_INPUT) instead of substituting the email address", async () => {
    // A direct POST omitting `username` entirely -- the shape a client that
    // bypasses the HTML form's `required` attribute (curl, a stale UI build,
    // a future caller) would send. Before the fix, `value(formData,
    // "username") ?? value(formData, "email")` silently substituted the
    // email address here and the request would instead proceed to attempt a
    // real IMAP/SMTP connection under the wrong identity.
    const result = await postConnectSmtpMailbox(validFieldsExceptUsername);
    expect(result.status).toBe(303);
    expect(result.notice).toContain("INVALID_INPUT");
  });

  it("rejects a whitespace-only username the same way (the HTML required attribute alone cannot catch this)", async () => {
    const result = await postConnectSmtpMailbox({
      ...validFieldsExceptUsername,
      username: "   ",
    });
    expect(result.status).toBe(303);
    expect(result.notice).toContain("INVALID_INPUT");
  });

  it("still accepts an explicitly supplied username distinct from the email address (no regression)", async () => {
    // Proves the fix didn't just delete the field: a real, non-empty
    // username (the common case -- Zimbra-style logins are rarely the full
    // email address) must still reach `connectSmtpImapMailbox` and only fail
    // for a reason *other* than input validation (a real network attempt
    // against an unreachable host times out/fails to connect, reported as
    // an IMAP_AUTH_FAILED-shaped failure, never INVALID_INPUT).
    const result = await postConnectSmtpMailbox({
      ...validFieldsExceptUsername,
      username: "corentin.sacazes",
      imapHost: "127.0.0.1",
      imapPort: "1",
    });
    expect(result.status).toBe(303);
    expect(result.notice).not.toContain("INVALID_INPUT");
  }, 20_000);
});
