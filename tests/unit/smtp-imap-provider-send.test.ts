import { describe, expect, it, vi } from "vitest";

// No `vi.mock("server-only", ...)` here: `smtp-imap-mail-provider.ts` no
// longer imports that marker (Task 10 fix round 1) since it is reachable
// from `trigger/tasks.ts`'s plain Node worker graph, where `server-only`
// throws unconditionally rather than being a no-op.

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");
const { buildMime } = await import("@/lib/smtp-imap/mime");
const { outreachMessageId } = await import("@/lib/smtp-imap/message-id");

import type { ImapFetchedMessage, ImapPort } from "@/lib/smtp-imap/imap-client";
import type { SmtpPort } from "@/lib/smtp-imap/smtp-client";
import type {
  SendJournal,
  SmtpRejectionDetails,
} from "@/modules/mailboxes/smtp-imap-mail-provider";

const { SmtpRejectionError } = await import("@/lib/smtp-imap/smtp-client");

// `sendDraft` is only ever given `draftId`/`outreachId`/`mailboxId` — none of
// the recipient/subject/body that produced the draft in the first place.
// The only place that content still exists is the Drafts folder itself, so
// the real provider reads it back via `imap.fetchDraftSource` before
// submitting via SMTP (see "Fetching the draft to submit" in the report).
// This fixture is what a real `createDraft` call would have appended.
const draftMessageId = outreachMessageId("outreach-42", "d.tld");
const draftMime = buildMime(
  {
    sender: "boite@d.tld",
    recipient: "prospect@example.com",
    subject: "Sujet",
    body: "Corps",
    headers: {},
  },
  draftMessageId,
);

/** Fails loudly instead of returning `undefined` — a call this test did not
 * expect should show up as a thrown error naming the method, not as a
 * silent success on garbage data. */
function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

/** Fully typed against `ImapPort` — every method present — so a signature
 * drift on any of them (not just the ones a given test exercises) fails
 * `tsc`, not just at runtime. Unused methods default to `unexpected`. */
function createImap(overrides: Partial<ImapPort>): ImapPort {
  return {
    resolveFolders: vi.fn(unexpected("resolveFolders")),
    appendDraft: vi.fn(unexpected("appendDraft")),
    findByMessageId: vi.fn(unexpected("findByMessageId")),
    moveToSent: vi.fn(unexpected("moveToSent")),
    fetchDraftSource: vi.fn(unexpected("fetchDraftSource")),
    status: vi.fn(unexpected("status")),
    fetchRange: function unexpectedFetchRange(): AsyncGenerator<
      ImapFetchedMessage[]
    > {
      throw new Error("unexpected call: fetchRange");
    },
    findFirstUidSince: vi.fn(unexpected("findFirstUidSince")),
    ...overrides,
  };
}

function createSmtp(overrides: Partial<SmtpPort>): SmtpPort {
  return {
    submit: vi.fn(unexpected("submit")),
    verify: vi.fn(unexpected("verify")),
    ...overrides,
  };
}

function createJournal(overrides: Partial<SendJournal>): SendJournal {
  return {
    hasAttempt: vi.fn(unexpected("hasAttempt")),
    hasAcceptance: vi.fn(unexpected("hasAcceptance")),
    getPermanentRejection: vi.fn(unexpected("getPermanentRejection")),
    recordAttempt: vi.fn(unexpected("recordAttempt")),
    recordAcceptance: vi.fn(unexpected("recordAcceptance")),
    recordRejection: vi.fn(unexpected("recordRejection")),
    ...overrides,
  };
}

describe("smtp_imap sendDraft", () => {
  it("records acceptance before attempting the Sent copy", async () => {
    const order: string[] = [];
    const journal = createJournal({
      recordAttempt: vi.fn(async () => {
        order.push("attempt");
        return true;
      }),
      recordAcceptance: vi.fn(async () => void order.push("accepted")),
      hasAcceptance: vi.fn().mockResolvedValue(false),
    });
    const smtp = createSmtp({
      submit: vi.fn(async () => {
        order.push("smtp");
        return { messageId: draftMessageId, response: "250 OK" };
      }),
    });
    const imap = createImap({
      fetchDraftSource: vi.fn().mockResolvedValue(draftMime),
      moveToSent: vi.fn(async () => void order.push("sent-copy")),
    });

    const provider = new SmtpImapMailProvider(
      imap,
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );
    const result = await provider.sendDraft({
      draftId: "7:13",
      outreachId: "outreach-42",
      mailboxId: "mbx-1",
    });

    expect(result.status).toBe("accepted");
    expect(order).toEqual(["attempt", "smtp", "accepted", "sent-copy"]);
  });

  it("still reports acceptance when the Sent copy fails", async () => {
    const journal = createJournal({
      recordAttempt: vi.fn().mockResolvedValue(true),
      recordAcceptance: vi.fn().mockResolvedValue(undefined),
      hasAcceptance: vi.fn().mockResolvedValue(false),
    });
    const provider = new SmtpImapMailProvider(
      createImap({
        fetchDraftSource: vi.fn().mockResolvedValue(draftMime),
        moveToSent: vi.fn().mockRejectedValue(new Error("IMAP down")),
      }),
      createSmtp({
        submit: vi
          .fn()
          .mockResolvedValue({ messageId: draftMessageId, response: "250 OK" }),
      }),
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(journal.recordAcceptance).toHaveBeenCalledTimes(1);
  });

  it("never submits twice when acceptance is already recorded", async () => {
    const smtp = createSmtp({});
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(true),
    });
    const provider = new SmtpImapMailProvider(
      createImap({}),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await provider.sendDraft({
      draftId: "7:13",
      outreachId: "outreach-42",
      mailboxId: "mbx-1",
    });

    expect(smtp.submit).not.toHaveBeenCalled();
  });

  it("refuses to submit when the fetched draft's Message-ID does not match the expected one", async () => {
    // Built with an unrelated Message-ID — as if `uidValidity:uid` in
    // `draftId` pointed at someone else's message (a stale/reused UID, a
    // wrong mailbox, ...). This is the only check standing between
    // `sendDraft` and mailing the wrong content to the wrong prospect.
    const wrongMime = buildMime(
      {
        sender: "boite@d.tld",
        recipient: "prospect@example.com",
        subject: "Sujet",
        body: "Corps",
        headers: {},
      },
      "<unrelated@d.tld>",
    );
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
    });
    const smtp = createSmtp({});
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(wrongMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toThrow(/Message-ID mismatch/);
    expect(smtp.submit).not.toHaveBeenCalled();
    expect(journal.recordAttempt).not.toHaveBeenCalled();
  });

  it("refuses to submit when the fetched draft carries no To header", async () => {
    const mimeWithoutRecipient =
      [
        "From: boite@d.tld",
        "Subject: Sujet",
        "Date: Wed, 01 Jan 2026 00:00:00 +0000",
        `Message-ID: ${draftMessageId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
      ].join("\r\n") + "\r\n\r\nQ29ycHM=";
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
    });
    const smtp = createSmtp({});
    const provider = new SmtpImapMailProvider(
      createImap({
        fetchDraftSource: vi.fn().mockResolvedValue(mimeWithoutRecipient),
      }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toThrow(/no "To" header/);
    expect(smtp.submit).not.toHaveBeenCalled();
  });

  it("refuses a malformed draftId without ever touching IMAP or SMTP", async () => {
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
    });
    const smtp = createSmtp({});
    const imap = createImap({});
    const provider = new SmtpImapMailProvider(
      imap,
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "not-a-draft-id",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toThrow(/Malformed draftId/);
    expect(smtp.submit).not.toHaveBeenCalled();
    expect(imap.fetchDraftSource).not.toHaveBeenCalled();
  });

  it("refuses to submit a second time when an attempt is already recorded without acceptance", async () => {
    // The TOCTOU/crash-recovery guard: `recordAttempt` resolving `false`
    // means some other attempt (concurrent, or a previous crashed run)
    // already exists for this key with no matching acceptance yet.
    // Blocking here is deliberate — the alternative is a guessed retry
    // that could double-send.
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(false),
    });
    const smtp = createSmtp({});
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toThrow(/already recorded/);
    expect(smtp.submit).not.toHaveBeenCalled();
  });

  it("releases the attempt and records a rejection when the server issues a definite 4xx refusal", async () => {
    // The greylisting case: a `451` on a first send from a new client is
    // transient (design doc §8) — the attempt must be released so a later
    // `sendDraft` can actually resubmit, not stay blocked forever.
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      451,
      "451 4.7.1 Greylisted, try again later",
      "EENVELOPE",
    );
    const recordRejection = vi.fn(async () => undefined);
    const recordAcceptance = vi.fn(unexpected("recordAcceptance"));
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(true),
      recordRejection,
      recordAcceptance,
    });
    const smtp = createSmtp({ submit: vi.fn().mockRejectedValue(rejection) });
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toBe(rejection);

    expect(recordRejection).toHaveBeenCalledTimes(1);
    const [messageKey, details] = recordRejection.mock.calls[0] as unknown as [
      string,
      SmtpRejectionDetails,
    ];
    expect(messageKey).toBe(draftMessageId);
    expect(details).toEqual({
      responseCode: 451,
      response: "451 4.7.1 Greylisted, try again later",
      smtpErrorCode: "EENVELOPE",
      releaseAttempt: true,
    });
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("keeps the attempt in place and records a rejection when the server issues a definite 5xx refusal", async () => {
    // A permanent refusal (nonexistent mailbox, content rejected) will
    // never succeed on retry — reopening the key would only let the same
    // doomed content be resubmitted and mask the real problem, so the
    // attempt stays exactly as `recordAttempt` left it. Only the audit
    // trail is new.
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      550,
      "550 5.1.1 No such user",
      "EENVELOPE",
    );
    const recordRejection = vi.fn(async () => undefined);
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(true),
      recordRejection,
      recordAcceptance: vi.fn(unexpected("recordAcceptance")),
    });
    const smtp = createSmtp({ submit: vi.fn().mockRejectedValue(rejection) });
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toBe(rejection);

    expect(recordRejection).toHaveBeenCalledTimes(1);
    const [, details] = recordRejection.mock.calls[0] as unknown as [
      string,
      SmtpRejectionDetails,
    ];
    expect(details).toEqual({
      responseCode: 550,
      response: "550 5.1.1 No such user",
      smtpErrorCode: "EENVELOPE",
      releaseAttempt: false,
    });
  });

  it("releases the attempt on an EAUTH rejection even though its response code is numerically a 5xx", async () => {
    // Authentication fails before MAIL FROM is ever sent -- of every
    // rejection this journal sees, this is the one with the strongest
    // possible evidence the message itself was never submitted. The
    // numeric `535` alone would read as a permanent 5xx and stay blocked;
    // `smtpErrorCode === "EAUTH"` overrides that and releases anyway (see
    // `SmtpRejectionDetails`).
    const rejection = new SmtpRejectionError(
      "Invalid login",
      535,
      "535 5.7.8 Authentication failed",
      "EAUTH",
    );
    const recordRejection = vi.fn(async () => undefined);
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(true),
      recordRejection,
      recordAcceptance: vi.fn(unexpected("recordAcceptance")),
    });
    const smtp = createSmtp({ submit: vi.fn().mockRejectedValue(rejection) });
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toBe(rejection);

    expect(recordRejection).toHaveBeenCalledTimes(1);
    const [, details] = recordRejection.mock.calls[0] as unknown as [
      string,
      SmtpRejectionDetails,
    ];
    expect(details).toEqual({
      responseCode: 535,
      response: "535 5.7.8 Authentication failed",
      smtpErrorCode: "EAUTH",
      releaseAttempt: true,
    });
  });

  it("never calls recordRejection for an ambiguous failure carrying no server response code", async () => {
    // A dropped connection: the server's verdict, if any, is unknown — the
    // message may already have been accepted. `recordRejection` stays
    // untouched (`createJournal`'s default throws loudly if it is called
    // at all) and the attempt stays exactly as `recordAttempt` left it.
    const connectionError = new Error("socket hang up") as Error & {
      code?: string;
    };
    connectionError.code = "ESOCKET";
    const journal = createJournal({
      hasAcceptance: vi.fn().mockResolvedValue(false),
      recordAttempt: vi.fn().mockResolvedValue(true),
      recordAcceptance: vi.fn(unexpected("recordAcceptance")),
    });
    const smtp = createSmtp({
      submit: vi.fn().mockRejectedValue(connectionError),
    });
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      smtp,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      }),
    ).rejects.toBe(connectionError);
  });
});

/**
 * An in-memory `SendJournal` implementing the *real* release semantics
 * `WorkflowEventsSendJournal` provides against Postgres — an
 * `onConflictDoNothing`-style attempt mutex, plus `recordRejection`
 * deleting that mutex only when `releaseAttempt` is `true`. Proving "a
 * second `sendDraft` actually resubmits after a 4xx" needs a journal that
 * behaves like the real one across two calls, not a single canned mock
 * response — a `vi.fn()` stub can assert it was *called* with the right
 * arguments, but only a stateful fake can prove the *next* `sendDraft`
 * call sees the consequences.
 */
class FakeSendJournal implements SendJournal {
  async getPermanentRejection(): Promise<SmtpRejectionDetails | null> {
    return null;
  }
  private readonly attempted = new Set<string>();
  private readonly accepted = new Set<string>();

  async hasAttempt(messageKey: string): Promise<boolean> {
    return this.attempted.has(messageKey);
  }

  async hasAcceptance(messageKey: string): Promise<boolean> {
    return this.accepted.has(messageKey);
  }

  async recordAttempt(messageKey: string): Promise<boolean> {
    if (this.attempted.has(messageKey)) return false;
    this.attempted.add(messageKey);
    return true;
  }

  async recordAcceptance(messageKey: string): Promise<void> {
    this.accepted.add(messageKey);
  }

  async recordRejection(
    messageKey: string,
    rejection: SmtpRejectionDetails,
  ): Promise<void> {
    if (rejection.releaseAttempt) {
      this.attempted.delete(messageKey);
    }
  }
}

describe("smtp_imap sendDraft retried after a definite rejection", () => {
  it("actually resubmits on a second sendDraft after a 4xx release", async () => {
    const journal = new FakeSendJournal();
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      451,
      "451 4.7.1 Greylisted, try again later",
      "EENVELOPE",
    );
    const submit = vi
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ messageId: draftMessageId, response: "250 OK" });
    const moveToSent = vi.fn().mockResolvedValue(undefined);
    const provider = new SmtpImapMailProvider(
      createImap({
        fetchDraftSource: vi.fn().mockResolvedValue(draftMime),
        moveToSent,
      }),
      createSmtp({ submit }),
      "mbx-1",
      "boite@d.tld",
      journal,
    );
    const call = () =>
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      });

    await expect(call()).rejects.toBe(rejection);
    expect(submit).toHaveBeenCalledTimes(1);

    await expect(call()).resolves.toEqual({ status: "accepted" });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("still refuses a second sendDraft after a 5xx (the attempt is never released)", async () => {
    const journal = new FakeSendJournal();
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      550,
      "550 5.1.1 No such user",
      "EENVELOPE",
    );
    const submit = vi.fn().mockRejectedValue(rejection);
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      createSmtp({ submit }),
      "mbx-1",
      "boite@d.tld",
      journal,
    );
    const call = () =>
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      });

    await expect(call()).rejects.toBe(rejection);
    expect(submit).toHaveBeenCalledTimes(1);

    await expect(call()).rejects.toThrow(/already recorded/);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("still refuses a second sendDraft after an ambiguous connection failure", async () => {
    const journal = new FakeSendJournal();
    const connectionError = new Error("socket hang up") as Error & {
      code?: string;
    };
    connectionError.code = "ESOCKET";
    const submit = vi.fn().mockRejectedValue(connectionError);
    const provider = new SmtpImapMailProvider(
      createImap({ fetchDraftSource: vi.fn().mockResolvedValue(draftMime) }),
      createSmtp({ submit }),
      "mbx-1",
      "boite@d.tld",
      journal,
    );
    const call = () =>
      provider.sendDraft({
        draftId: "7:13",
        outreachId: "outreach-42",
        mailboxId: "mbx-1",
      });

    await expect(call()).rejects.toBe(connectionError);
    expect(submit).toHaveBeenCalledTimes(1);

    await expect(call()).rejects.toThrow(/already recorded/);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
