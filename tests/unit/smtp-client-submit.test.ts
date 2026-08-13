import { describe, expect, it, vi } from "vitest";

/**
 * `classifySmtpRejection` is proven pure (`smtp-client-rejection.test.ts`)
 * and the provider-level dispatch off a `SmtpRejectionError` is proven
 * against `SmtpPort` doubles (`smtp-imap-provider-send.test.ts`) — but
 * nothing exercised the eight lines in `submit`'s own `catch` block that
 * actually connect the two: converting a *real* `nodemailer` failure into
 * the `SmtpRejectionError` `sendDraft` depends on. A regression there
 * (e.g. the `catch` silently dropped, or `classifySmtpRejection` never
 * actually called) would pass every other test in this suite while
 * silently reintroducing the exact bug this whole fix exists to close.
 *
 * `nodemailer` itself is mocked at the module boundary — `createTransport`
 * returns a fake transporter whose `sendMail` is scripted per test. No
 * network socket, real or fake, is ever opened.
 */
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(),
  },
}));

const nodemailer = (await import("nodemailer")).default as unknown as {
  createTransport: ReturnType<typeof vi.fn>;
};
const { SmtpClient, SmtpRejectionError } =
  await import("@/lib/smtp-imap/smtp-client");
const { buildMime } = await import("@/lib/smtp-imap/mime");

const transport = {
  username: "boite@d.tld",
  imap: { host: "imap.d.tld", port: 993, security: "tls" as const },
  smtp: { host: "smtp.d.tld", port: 465, security: "tls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};
const credentials = { user: "boite@d.tld", pass: "secret" };

const mime = buildMime(
  {
    sender: "boite@d.tld",
    recipient: "prospect@example.com",
    subject: "Sujet",
    body: "Corps",
    headers: {},
  },
  "<outreach-42@d.tld>",
);

function stubTransport(sendMail: ReturnType<typeof vi.fn>): {
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  nodemailer.createTransport.mockReturnValueOnce({ sendMail, close });
  return { close };
}

describe("SmtpClient.submit", () => {
  it("wraps a real nodemailer 451 RCPT-TO rejection into a SmtpRejectionError", async () => {
    const rcptError = new Error("Recipient command failed") as Error & {
      code?: string;
      response?: string;
      responseCode?: number;
    };
    rcptError.code = "EENVELOPE";
    rcptError.response = "451 4.7.1 Greylisted, try again later";
    rcptError.responseCode = 451;
    const sendMail = vi.fn().mockRejectedValue(rcptError);
    const { close } = stubTransport(sendMail);
    const client = new SmtpClient(transport, credentials);

    let caught: unknown;
    try {
      await client.submit(mime, {
        from: "boite@d.tld",
        to: "prospect@example.com",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmtpRejectionError);
    const rejection = caught as InstanceType<typeof SmtpRejectionError>;
    expect(rejection.responseCode).toBe(451);
    expect(rejection.response).toBe("451 4.7.1 Greylisted, try again later");
    expect(rejection.smtpErrorCode).toBe("EENVELOPE");
    // The transport is still closed on the rejection path.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps a real nodemailer 550 refusal into a SmtpRejectionError", async () => {
    const rcptError = new Error("Recipient command failed") as Error & {
      code?: string;
      response?: string;
      responseCode?: number;
    };
    rcptError.code = "EENVELOPE";
    rcptError.response = "550 5.1.1 No such user";
    rcptError.responseCode = 550;
    const sendMail = vi.fn().mockRejectedValue(rcptError);
    stubTransport(sendMail);
    const client = new SmtpClient(transport, credentials);

    await expect(
      client.submit(mime, { from: "boite@d.tld", to: "prospect@example.com" }),
    ).rejects.toBeInstanceOf(SmtpRejectionError);
  });

  it("passes an ambiguous connection failure through unwrapped, not as a SmtpRejectionError", async () => {
    const socketError = new Error("socket hang up") as Error & {
      code?: string;
    };
    socketError.code = "ESOCKET";
    const sendMail = vi.fn().mockRejectedValue(socketError);
    const { close } = stubTransport(sendMail);
    const client = new SmtpClient(transport, credentials);

    let caught: unknown;
    try {
      await client.submit(mime, {
        from: "boite@d.tld",
        to: "prospect@example.com",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(socketError);
    expect(caught).not.toBeInstanceOf(SmtpRejectionError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resolves normally on a real accepted send, untouched by the classification path", async () => {
    const sendMail = vi.fn().mockResolvedValue({
      accepted: ["prospect@example.com"],
      rejected: [],
      response: "250 2.0.0 OK",
    });
    stubTransport(sendMail);
    const client = new SmtpClient(transport, credentials);

    await expect(
      client.submit(mime, { from: "boite@d.tld", to: "prospect@example.com" }),
    ).resolves.toEqual({
      messageId: "<outreach-42@d.tld>",
      response: "250 2.0.0 OK",
    });
  });
});
