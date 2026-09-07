import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const capture = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ ok: false, code: "IMAP_AUTH_FAILED" }),
}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/modules/mailboxes/smtp-imap-connection-service", () => ({
  connectSmtpImapMailbox: capture.connect,
  disconnectSmtpImapMailbox: vi.fn(),
}));
import { POST } from "@/app/api/operator/commands/[command]/route";
import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/lib/operator-auth";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it.each([" synthetic-password \t", "   "])(
  "preserves the exact submitted SMTP credential %j",
  async (password) => {
    vi.stubEnv("OPERATOR_EMAIL", "fixture@example.test");
    vi.stubEnv("OPERATOR_PASSWORD", "synthetic-operator-password");
    vi.stubEnv("SESSION_SECRET", "synthetic-session-secret-at-least-32-chars");
    const { token, session } = createOperatorSession();
    const body = new FormData();
    for (const [key, value] of Object.entries({
      csrf: session.csrfToken,
      email: "mailbox@example.test",
      username: "fixture-user",
      password,
      imapHost: "imap.example.invalid",
      imapPort: "993",
      imapSecurity: "tls",
      smtpHost: "smtp.example.invalid",
      smtpPort: "587",
      smtpSecurity: "starttls",
    }))
      body.set(key, value);
    const response = await POST(
      new Request(
        "http://operator.local/api/operator/commands/connect-smtp-mailbox",
        {
          method: "POST",
          body,
          headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
        },
      ),
      { params: Promise.resolve({ command: "connect-smtp-mailbox" }) },
    );
    expect(response.status).toBe(303);
    expect(capture.connect).toHaveBeenCalledTimes(1);
    expect(capture.connect.mock.calls[0]?.[1].password).toBe(password);
  },
);
