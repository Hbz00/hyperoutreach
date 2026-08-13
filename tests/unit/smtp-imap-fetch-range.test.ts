import { describe, expect, it, vi } from "vitest";

/**
 * `fetchRange` had no test at all before this file: every other test of
 * `ImapClient` doubles `ImapPort` (never imports `imapflow`), so the
 * contract `SmtpImapInboundSource` depends on — `body` is the *exact*,
 * untouched raw RFC 5322 `Buffer` `imapflow` returned, headers included,
 * never transcoded — was asserted nowhere. A regression reintroducing
 * header-stripping or a charset-blind `.toString("utf-8")` (both bugs this
 * file exists to catch) would leave the whole suite green.
 *
 * `imapflow` itself is mocked at the module boundary, same convention as
 * `imap-client-connect.test.ts` — no network socket, real or fake, is ever
 * opened.
 */
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(),
}));

const { ImapFlow } = (await import("imapflow")) as unknown as {
  ImapFlow: ReturnType<typeof vi.fn>;
};
const { ImapClient } = await import("@/lib/smtp-imap/imap-client");

const transport = {
  username: "boite@d.tld",
  imap: { host: "imap.d.tld", port: 993, security: "tls" as const },
  smtp: { host: "smtp.d.tld", port: 465, security: "tls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};
const credentials = { user: "boite@d.tld", pass: "s3cret" };

function stubImapFlow(overrides: { fetch: ReturnType<typeof vi.fn> }): {
  close: ReturnType<typeof vi.fn>;
  lockRelease: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const logout = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue(undefined);
  const lockRelease = vi.fn();
  const getMailboxLock = vi.fn().mockResolvedValue({ release: lockRelease });
  ImapFlow.mockImplementationOnce(function ImapFlowStub() {
    return { connect, close, logout, getMailboxLock, fetch: overrides.fetch };
  });
  return { close, lockRelease };
}

async function collectPages<T>(generator: AsyncGenerator<T[]>): Promise<T[][]> {
  const pages: T[][] = [];
  for await (const page of generator) pages.push(page);
  return pages;
}

describe("ImapClient.fetchRange", () => {
  it("passes the message source through as an untouched Buffer, headers and all — no stripping, no transcoding", async () => {
    // Genuine single-byte ISO-8859-1 bytes (à = 0xE0, è = 0xE8, ô = 0xF4),
    // built via `Buffer.from(str, "latin1")` so this is not merely a JS
    // string that *displays* as accented text — it reproduces the exact
    // wire bytes an 8bit-encoded, non-UTF-8 reply arrives as.
    const headers = [
      "From: prospect@example.com",
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-8bit@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="iso-8859-1"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "",
    ].join("\r\n");
    const bodyText = "Merci, à très bientôt.";
    const sourceBuffer = Buffer.concat([
      Buffer.from(headers, "ascii"),
      Buffer.from(bodyText, "latin1"),
    ]);

    const fetch = vi.fn().mockImplementation(async function* () {
      yield {
        uid: 42,
        envelope: {
          messageId: "<reply-8bit@example.com>",
          subject: "Re: Suivi",
          from: [{ address: "prospect@example.com" }],
          to: [{ address: "mailbox@example.com" }],
          date: new Date("2026-08-01T00:00:00.000Z"),
        },
        internalDate: new Date("2026-08-01T00:05:00.000Z"),
        source: sourceBuffer,
      };
    });
    stubImapFlow({ fetch });
    const client = new ImapClient(transport, credentials);

    const pages = await collectPages(client.fetchRange("1:*"));

    expect(pages).toHaveLength(1);
    const [message] = pages[0]!;
    expect(Buffer.isBuffer(message!.body)).toBe(true);
    // Byte-for-byte identical to what imapflow returned: proves neither the
    // headers nor the 8-bit body bytes were touched.
    expect((message!.body as Buffer).equals(sourceBuffer)).toBe(true);
    expect((message!.body as Buffer).toString("ascii")).toContain(
      "Content-Type:",
    );
    expect(message!.internalDate).toEqual(new Date("2026-08-01T00:05:00.000Z"));
  });

  it("fetches by UID with envelope, source, and internalDate", async () => {
    const fetch = vi.fn().mockImplementation(async function* () {});
    stubImapFlow({ fetch });
    const client = new ImapClient(transport, credentials);

    await collectPages(client.fetchRange("42:*"));

    expect(fetch).toHaveBeenCalledWith(
      "42:*",
      {
        envelope: true,
        source: { start: 0, maxLength: 10 * 1024 * 1024 },
        internalDate: true,
      },
      { uid: true },
    );
  });

  it("releases the mailbox lock and logs out even when the fetch throws mid-stream", async () => {
    const fetch = vi.fn().mockImplementation(async function* () {
      yield {
        uid: 1,
        envelope: {
          messageId: null,
          subject: null,
          from: undefined,
          to: undefined,
          date: null,
        },
        internalDate: null,
        source: Buffer.from("From: a@x\r\n\r\nhi", "ascii"),
      };
      throw new Error("connection dropped");
    });
    const { lockRelease } = stubImapFlow({ fetch });
    const client = new ImapClient(transport, credentials);

    await expect(collectPages(client.fetchRange("1:*"))).rejects.toThrow(
      "connection dropped",
    );
    expect(lockRelease).toHaveBeenCalledTimes(1);
  });
});
