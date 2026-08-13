import { describe, expect, it, vi } from "vitest";

// No `vi.mock("server-only", ...)` here: `smtp-imap-mail-provider.ts` no
// longer imports that marker (Task 10 fix round 1) since it is reachable
// from `trigger/tasks.ts`'s plain Node worker graph, where `server-only`
// throws unconditionally rather than being a no-op.

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");

const MAILBOX_EMAIL = "boite@polytechnique.edu";

const input = {
  outreachId: "outreach-42",
  mailboxId: "mbx-1",
  sender: "corentin.sacazes@polytechnique.edu",
  recipient: "prospect@example.com",
  subject: "Sujet",
  body: "Corps",
  headers: {},
};

describe("smtp_imap createDraft", () => {
  it("reuses an existing draft found by message id instead of appending twice", async () => {
    const imap = {
      findByMessageId: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 12 }),
      appendDraft: vi.fn(),
    };
    const provider = new SmtpImapMailProvider(
      imap as never,
      {} as never,
      "mbx-1",
      MAILBOX_EMAIL,
      {} as never,
    );

    const draft = await provider.createDraft(input as never);

    expect(draft.draftId).toBe("7:12");
    expect(imap.appendDraft).not.toHaveBeenCalled();
  });

  it("appends when no draft exists yet", async () => {
    const imap = {
      findByMessageId: vi.fn().mockResolvedValue(null),
      appendDraft: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
    };
    const provider = new SmtpImapMailProvider(
      imap as never,
      {} as never,
      "mbx-1",
      MAILBOX_EMAIL,
      {} as never,
    );

    const draft = await provider.createDraft(input as never);

    expect(draft.draftId).toBe("7:13");
    expect(imap.appendDraft).toHaveBeenCalledTimes(1);
  });

  it("refuses a mailbox binding mismatch", async () => {
    const provider = new SmtpImapMailProvider(
      {} as never,
      {} as never,
      "mbx-1",
      "boite@d.tld",
      {} as never,
    );
    await expect(
      provider.createDraft({ ...input, mailboxId: "autre" } as never),
    ).rejects.toThrow("mailbox binding mismatch");
  });

  it("searches the same folder role that appendDraft writes to", async () => {
    // `ImapPort.findByMessageId`'s first argument is a folder *role*
    // ("drafts" | "sent"), resolved to the real transport path inside
    // `ImapClient` — the same resolution `appendDraft` uses internally.
    // A caller that searched a different role (or a hardcoded literal
    // folder name) than the one `appendDraft` writes to would silently
    // stop finding orphaned drafts and start double-appending on every
    // retry. This test inspects the actual argument to guard against
    // exactly that regression.
    const imap = {
      findByMessageId: vi.fn().mockResolvedValue(null),
      appendDraft: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
    };
    const provider = new SmtpImapMailProvider(
      imap as never,
      {} as never,
      "mbx-1",
      MAILBOX_EMAIL,
      {} as never,
    );

    await provider.createDraft(input as never);

    expect(imap.findByMessageId).toHaveBeenCalledWith(
      "drafts",
      expect.any(String),
      undefined,
    );
  });
});
