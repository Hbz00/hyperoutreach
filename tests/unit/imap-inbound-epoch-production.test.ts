import { expect, it, vi } from "vitest";

vi.mock("imapflow", () => ({ ImapFlow: vi.fn() }));
const { ImapFlow } = (await import("imapflow")) as unknown as {
  ImapFlow: ReturnType<typeof vi.fn>;
};
const { ImapClient } = await import("@/lib/smtp-imap/imap-client");
const { SmtpImapInboundSource } =
  await import("@/modules/mailboxes/smtp-imap-inbound-source");

const transport = {
  username: "operator@example.test",
  imap: { host: "unused.invalid", port: 993, security: "tls" as const },
  smtp: { host: "unused.invalid", port: 465, security: "tls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};

function fixture(selectedEpoch: bigint | undefined, statusEpoch = 7n) {
  const statusLogout = vi.fn().mockResolvedValue(undefined);
  const fetchLogout = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const fetchMessages = vi.fn(async function* () {
    yield {
      uid: 42,
      source: Buffer.from(
        "From: prospect@example.test\r\nTo: operator@example.test\r\nMessage-ID: <fixture@example.test>\r\n\r\nPlease unsubscribe me",
      ),
      internalDate: new Date("2026-09-06T00:00:00Z"),
    };
  });
  // STATUS and FETCH use distinct real wrapper connections. The fixture
  // represents an inbox recreated between those two connections, with a UID
  // now naming a different message. No network transport is constructed.
  ImapFlow.mockImplementationOnce(function StatusConnection() {
    return {
      connect: async () => {},
      status: async () => ({ uidValidity: statusEpoch, uidNext: 43 }),
      logout: statusLogout,
    };
  });
  ImapFlow.mockImplementationOnce(function FetchConnection() {
    return {
      connect: async () => {},
      mailbox: { uidValidity: selectedEpoch },
      getMailboxLock: async () => ({ release }),
      fetch: fetchMessages,
      logout: fetchLogout,
    };
  });
  const imap = new ImapClient(transport, { user: "fixture", pass: "fixture" });
  return {
    source: new SmtpImapInboundSource(imap, "mailbox-fixture"),
    fetchMessages,
    release,
    fetchLogout,
    statusLogout,
  };
}

it.each([8n, undefined])(
  "refuses a fetched inbox epoch %s that cannot match its earlier STATUS",
  async (selectedEpoch) => {
    const f = fixture(selectedEpoch);
    const ingest = vi.fn().mockResolvedValue(1);
    await expect(f.source.fetchSince("7:41", ingest)).rejects.toThrow(
      "UIDVALIDITY",
    );
    expect(ingest).not.toHaveBeenCalled();
    expect(f.fetchMessages).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.fetchLogout).toHaveBeenCalledOnce();
    expect(f.statusLogout).toHaveBeenCalledOnce();
  },
);

it.each([
  { epoch: 7n, rebaselined: false },
  { epoch: 8n, rebaselined: true },
])(
  "ingests a consistent epoch $epoch and preserves rebaseline semantics",
  async ({ epoch, rebaselined }) => {
    const f = fixture(epoch, epoch);
    const ingest = vi.fn().mockResolvedValue(1);
    expect(await f.source.fetchSince("7:41", ingest)).toEqual({
      nextCursor: `${epoch}:42`,
      rebaselined,
    });
    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest.mock.calls[0]![0][0]).toMatchObject({
      providerNotificationId: `imap:${epoch}:42`,
      body: "Please unsubscribe me",
    });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.fetchLogout).toHaveBeenCalledOnce();
    expect(f.statusLogout).toHaveBeenCalledOnce();
  },
);
