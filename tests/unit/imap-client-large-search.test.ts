import { describe, expect, it, vi } from "vitest";

/**
 * `findFirstUidSince`/`searchByMessageId` used to reduce a `client.search()`
 * result with `Math.min(...uids)`/`Math.max(...uids)` — spreading a large
 * array into call arguments throws `RangeError: Maximum call stack size
 * exceeded` past roughly 100k elements (measured). A `SEARCH SINCE` result
 * that size is a real scenario on a high-volume mailbox with a months-old
 * sync gap, and the crash would abort `fetchSince` before the cursor
 * advances — exactly the class of failure this method exists to prevent,
 * reintroduced one call deeper. Same convention as `imap-client-connect.test.ts`:
 * `imapflow` doubled at the module boundary, no network socket.
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

// Comfortably past the ~100k argument limit that trips `Math.min(...uids)`.
const LARGE_RESULT_SIZE = 150_000;

function stubImapFlow(search: ReturnType<typeof vi.fn>): void {
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const logout = vi.fn().mockResolvedValue(undefined);
  const getMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
  ImapFlow.mockImplementationOnce(function ImapFlowStub() {
    return {
      connect,
      close,
      logout,
      getMailboxLock,
      search,
      mailbox: { uidValidity: 7n },
    };
  });
}

describe("ImapClient large SEARCH results", () => {
  it("findFirstUidSince finds the minimum uid across 150k results without a stack overflow", async () => {
    // Shuffled-ish so the true minimum isn't trivially the first element.
    const uids = Array.from(
      { length: LARGE_RESULT_SIZE },
      (_, i) => 1_000_000 - i,
    );
    uids[LARGE_RESULT_SIZE - 1] = 1; // true minimum, placed last
    const search = vi.fn().mockResolvedValue(uids);
    stubImapFlow(search);
    const client = new ImapClient(transport, credentials);

    await expect(
      client.findFirstUidSince(new Date("2026-01-01T00:00:00.000Z")),
    ).resolves.toBe(1);
  });

  it("findByMessageId finds the maximum uid across 150k results without a stack overflow", async () => {
    const uids = Array.from({ length: LARGE_RESULT_SIZE }, (_, i) => i + 1);
    uids[LARGE_RESULT_SIZE - 1] = 999_999; // true maximum, placed last
    const search = vi.fn().mockResolvedValue(uids);
    stubImapFlow(search);
    const client = new ImapClient(transport, credentials);

    await expect(client.findByMessageId("drafts", "<a@x>")).resolves.toEqual({
      uidValidity: 7,
      uid: 999_999,
    });
  });
});
