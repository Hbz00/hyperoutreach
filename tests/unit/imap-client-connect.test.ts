import { describe, expect, it, vi } from "vitest";

/**
 * `classifyImapAuthFailure` is proven pure (`imap-client-auth-failure.test.ts`)
 * and the provider-level dispatch off `ImapAuthenticationError` is proven at
 * the `send-service.ts` level — but nothing exercised the eight-ish lines in
 * `withConnection`'s own `catch` block that actually connect the two:
 * converting a *real* `imapflow` `connect()` rejection into
 * `ImapAuthenticationError`. Same gap `smtp-client-submit.test.ts` closed for
 * `SmtpClient.submit` in this task's round 1, same fix.
 *
 * `imapflow` itself is mocked at the module boundary — the constructor
 * returns a fake client whose `connect`/`close`/`logout` are scripted per
 * test. No network socket, real or fake, is ever opened.
 */
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(),
}));

const { ImapFlow } = (await import("imapflow")) as unknown as {
  ImapFlow: ReturnType<typeof vi.fn>;
};
const { ImapClient, ImapAuthenticationError } =
  await import("@/lib/smtp-imap/imap-client");

const transport = {
  username: "boite@d.tld",
  imap: { host: "imap.d.tld", port: 993, security: "tls" as const },
  smtp: { host: "smtp.d.tld", port: 465, security: "tls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};
const credentials = { user: "boite@d.tld", pass: "wrong-password" };

function stubImapFlow(connect: ReturnType<typeof vi.fn>): {
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const logout = vi.fn().mockResolvedValue(undefined);
  // `new ImapFlow(...)` requires a real constructor -- an arrow function
  // mock implementation cannot be invoked with `new`. A plain function that
  // returns an object substitutes its return value for `this`, same effect.
  ImapFlow.mockImplementationOnce(function ImapFlowStub() {
    return { connect, close, logout };
  });
  return { close };
}

describe("ImapClient connection failures", () => {
  it("wraps a real imapflow LOGIN failure into ImapAuthenticationError", async () => {
    const authError = new Error("Command failed") as Error & {
      authenticationFailed?: boolean;
      response?: string;
    };
    authError.authenticationFailed = true;
    authError.response = "a2 NO Login failed";
    const connect = vi.fn().mockRejectedValue(authError);
    const { close } = stubImapFlow(connect);
    const client = new ImapClient(transport, credentials);

    let caught: unknown;
    try {
      await client.resolveFolders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ImapAuthenticationError);
    expect(
      (caught as InstanceType<typeof ImapAuthenticationError>).message,
    ).toBe("Command failed");
    // The connect-failure cleanup path still runs -- a wrapped error must
    // not skip closing the socket.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps a real imapflow SASL AUTHENTICATE failure into ImapAuthenticationError", async () => {
    const authError = new Error("Command failed") as Error & {
      authenticationFailed?: boolean;
      response?: string;
    };
    authError.authenticationFailed = true;
    authError.response = "a3 NO [AUTHENTICATIONFAILED] Invalid credentials";
    const connect = vi.fn().mockRejectedValue(authError);
    stubImapFlow(connect);
    const client = new ImapClient(transport, credentials);

    await expect(client.resolveFolders()).rejects.toBeInstanceOf(
      ImapAuthenticationError,
    );
  });

  it("passes an ambiguous connection failure through unwrapped, not as ImapAuthenticationError", async () => {
    const connError = new Error("connect ECONNREFUSED") as Error & {
      code?: string;
    };
    connError.code = "NoConnection";
    const connect = vi.fn().mockRejectedValue(connError);
    const { close } = stubImapFlow(connect);
    const client = new ImapClient(transport, credentials);

    let caught: unknown;
    try {
      await client.resolveFolders();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(connError);
    expect(caught).not.toBeInstanceOf(ImapAuthenticationError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes a connection drop mid-LOGIN (authenticationFailed set, no response text) through unwrapped", async () => {
    // login.js's own trap: authenticationFailed=true does not by itself mean
    // the credentials were rejected -- see classifyImapAuthFailure's doc.
    const midLoginDrop = new Error("Socket closed unexpectedly") as Error & {
      authenticationFailed?: boolean;
      response?: false;
    };
    midLoginDrop.authenticationFailed = true;
    midLoginDrop.response = false;
    const connect = vi.fn().mockRejectedValue(midLoginDrop);
    stubImapFlow(connect);
    const client = new ImapClient(transport, credentials);

    await expect(client.resolveFolders()).rejects.toBe(midLoginDrop);
  });
});
