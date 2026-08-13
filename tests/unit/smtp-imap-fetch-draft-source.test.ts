import { beforeEach, describe, expect, it, vi } from "vitest";

// No `vi.mock("server-only", ...)` here: `imap-client.ts` no longer imports
// that marker (Task 10 fix round 1 — see its own top-of-file comment) since
// it is reachable from `trigger/tasks.ts`'s plain Node worker graph, where
// `server-only` throws unconditionally rather than being a no-op.

// `ImapClient.fetchDraftSource` is real `imapflow`-driving code — the
// UIDVALIDITY refusal and the `fetchOne`-returns-`false`-on-a-miss handling
// have no coverage anywhere else, since every other test in this suite
// doubles `ImapPort` instead of exercising `ImapClient` itself. This file
// mocks `imapflow` directly (never a real connection) to close that gap.
const state = vi.hoisted(() => ({
  uidValidity: 7n as bigint | undefined,
  fetchOneResult: undefined as { source?: Buffer } | false | undefined,
}));

vi.mock("imapflow", () => {
  class FakeImapFlow {
    mailbox: { uidValidity: bigint } | undefined;
    async connect(): Promise<void> {}
    close(): void {}
    async logout(): Promise<void> {}
    async getMailboxLock(): Promise<{ release: () => void }> {
      this.mailbox =
        state.uidValidity === undefined
          ? undefined
          : { uidValidity: state.uidValidity };
      return { release: vi.fn() };
    }
    async fetchOne(): Promise<{ source?: Buffer } | false | undefined> {
      return state.fetchOneResult;
    }
  }
  return { ImapFlow: FakeImapFlow };
});

const { ImapClient } = await import("@/lib/smtp-imap/imap-client");

const transport = {
  username: "user@d.tld",
  imap: { host: "imap.d.tld", port: 993, security: "tls" as const },
  smtp: { host: "smtp.d.tld", port: 465, security: "tls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};
const credentials = { user: "user@d.tld", pass: "secret" };

describe("ImapClient.fetchDraftSource", () => {
  beforeEach(() => {
    state.uidValidity = 7n;
    state.fetchOneResult = undefined;
  });

  it("returns the message source decoded as UTF-8 when uidValidity matches", async () => {
    state.fetchOneResult = { source: Buffer.from("RAW MIME SOURCE", "utf-8") };
    const client = new ImapClient(transport, credentials);

    await expect(client.fetchDraftSource(7, 13)).resolves.toBe(
      "RAW MIME SOURCE",
    );
  });

  it("refuses when the Drafts folder's UIDVALIDITY has changed since the draft was created", async () => {
    state.uidValidity = 9n;
    state.fetchOneResult = { source: Buffer.from("RAW MIME SOURCE") };
    const client = new ImapClient(transport, credentials);

    await expect(client.fetchDraftSource(7, 13)).rejects.toThrow(
      /UIDVALIDITY changed/,
    );
  });

  it("throws when imapflow's fetchOne resolves false instead of the message", async () => {
    // imapflow returns `false` on a miss rather than throwing — an ignored
    // `false` here would read as an empty draft submitted via SMTP instead
    // of the hard failure it actually is.
    state.fetchOneResult = false;
    const client = new ImapClient(transport, credentials);

    await expect(client.fetchDraftSource(7, 13)).rejects.toThrow(
      /FETCH of draft uid 13/,
    );
  });

  it("throws when the fetched message carries no source at all", async () => {
    state.fetchOneResult = {};
    const client = new ImapClient(transport, credentials);

    await expect(client.fetchDraftSource(7, 13)).rejects.toThrow(
      /FETCH of draft uid 13/,
    );
  });

  it("throws when the Drafts mailbox has no readable UIDVALIDITY at all", async () => {
    state.uidValidity = undefined;
    const client = new ImapClient(transport, credentials);

    await expect(client.fetchDraftSource(7, 13)).rejects.toThrow(
      /could not read UIDVALIDITY/,
    );
  });
});
