import { describe, expect, it, vi } from "vitest";

// No `vi.mock("server-only", ...)` here: `smtp-imap-mail-provider.ts` no
// longer imports that marker (Task 10 fix round 1) since it is reachable
// from `trigger/tasks.ts`'s plain Node worker graph, where `server-only`
// throws unconditionally rather than being a no-op.

const { SmtpImapMailProvider } =
  await import("@/modules/mailboxes/smtp-imap-mail-provider");
const { outreachMessageId } = await import("@/lib/smtp-imap/message-id");
const { buildMime } = await import("@/lib/smtp-imap/mime");
const { SmtpRejectionError } = await import("@/lib/smtp-imap/smtp-client");

import type {
  SendJournal,
  SmtpRejectionDetails,
} from "@/modules/mailboxes/smtp-imap-mail-provider";

function build(
  journal: Record<string, unknown>,
  imap: Record<string, unknown>,
) {
  return new SmtpImapMailProvider(
    imap as never,
    {} as never,
    "mbx-1",
    "boite@d.tld",
    {
      getPermanentRejection: vi.fn().mockResolvedValue(null),
      ...journal,
    } as never,
  );
}

/**
 * Same stateful fake as `smtp-imap-provider-send.test.ts`'s
 * `FakeSendJournal` — duplicated locally rather than shared between the two
 * files, matching this suite's existing convention of self-contained test
 * files (`build`/`unexpected`/`createJournal`-style helpers are already
 * duplicated the same way across sibling `smtp-imap-provider-*.test.ts`
 * files). Implements the *real* release semantics
 * `WorkflowEventsSendJournal` provides against Postgres — proving
 * "`reconcile` stops reporting `accepted` after a released rejection"
 * needs a journal whose `hasAttempt` actually reflects what
 * `sendDraft`'s `recordRejection` call just did, not a single canned mock
 * response.
 */
class FakeSendJournal implements SendJournal {
  private readonly attempted = new Set<string>();
  private readonly accepted = new Set<string>();
  private readonly rejected = new Map<string, SmtpRejectionDetails>();

  async hasAttempt(messageKey: string): Promise<boolean> {
    return this.attempted.has(messageKey);
  }

  async hasAcceptance(messageKey: string): Promise<boolean> {
    return this.accepted.has(messageKey);
  }

  async getPermanentRejection(
    messageKey: string,
  ): Promise<SmtpRejectionDetails | null> {
    return this.rejected.get(messageKey) ?? null;
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
      this.rejected.delete(messageKey);
    } else {
      this.rejected.set(messageKey, rejection);
    }
  }
}

describe("smtp_imap reconcile precedence", () => {
  it("reports sent from the local journal even when the Sent copy is missing", async () => {
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(true),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      { findByMessageId: vi.fn().mockResolvedValue(null) },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });
    expect(result?.status).toBe("sent");
  });

  it("reports drafted when nothing was ever attempted", async () => {
    // Role-aware: step 3 checks Sent before Drafts (see the fix-round-1 note
    // below), so this double must answer `null` for "sent" and only match
    // on "drafts" -- a role-blind mock that answered truthy for either would
    // no longer exercise "nothing in Sent" at all.
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(false),
        hasAttempt: vi.fn().mockResolvedValue(false),
      },
      {
        findByMessageId: vi.fn(async (role: string) =>
          role === "drafts" ? { uidValidity: 7, uid: 13 } : null,
        ),
      },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: null,
      mailboxId: "mbx-1",
    });
    expect(result).toEqual({ status: "drafted", draftId: "7:13" });
  });

  // Fix round 1: the litigious case the reviewer traced through
  // `send-service.ts`. Step 3 is reached only when the journal knows nothing
  // at all -- including after a journal reset, or for a message this
  // provider never sent itself. In that state, IMAP folder state may have
  // been produced by the *server*, not by this code, so the "moveToSent is
  // atomic, folders are mutually exclusive" argument does not apply: Zimbra
  // (the design doc's own target server, §10) is documented to auto-classify
  // some sends into Sent on its own, while `moveToSent`'s best-effort nature
  // can leave an orphaned copy sitting in Drafts at the same time. Checking
  // Drafts first would report "drafted"; `send-service` then persists that
  // draftId, transitions to "sending", re-reconciles to the same "drafted"
  // answer, and calls `sendDraft` -- which submits, because the deterministic
  // Message-ID guard matches the orphaned draft perfectly. Sent must be
  // checked first so this path reports "sent" instead.
  it("prefers Sent over an orphaned Drafts copy when nothing was journaled (server-side auto-classification)", async () => {
    const findByMessageId = vi.fn(async (role: string) =>
      role === "sent"
        ? { uidValidity: 9, uid: 20 }
        : { uidValidity: 7, uid: 13 },
    );
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(false),
        hasAttempt: vi.fn().mockResolvedValue(false),
      },
      { findByMessageId },
    );

    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: null,
      mailboxId: "mbx-1",
    });

    expect(result?.status).toBe("sent");
  });

  it("never reports drafted when an attempt has no recorded outcome", async () => {
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(false),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      {
        findByMessageId: vi.fn().mockResolvedValue({ uidValidity: 7, uid: 13 }),
      },
    );
    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });
    expect(result?.status).not.toBe("drafted");
  });

  // Task 10's explicit consistency requirement: `reconcile` must derive the
  // journal key *exactly* the way `sendDraft` does (`outreachId` + the
  // mailbox's own domain via `outreachMessageId`/`domainOf`). A reconcile
  // that recomputed the key differently (e.g. from `draftId`, or from a
  // different domain source) would query a key `sendDraft` never wrote,
  // silently concluding "never attempted" on a message that already went
  // out -- the exact double-send hazard this task exists to close.
  it("derives the journal key exactly the way sendDraft does, from outreachId and the mailbox's own domain", async () => {
    const expectedKey = outreachMessageId("outreach-99", "d.tld");
    const hasAcceptance = vi.fn(async (key: string) => key === expectedKey);
    const provider = build(
      { hasAcceptance, hasAttempt: vi.fn().mockResolvedValue(false) },
      { findByMessageId: vi.fn().mockResolvedValue(null) },
    );

    const result = await provider.reconcile({
      outreachId: "outreach-99",
      draftId: "1:1",
      mailboxId: "mbx-1",
    });

    expect(hasAcceptance).toHaveBeenCalledWith(expectedKey);
    expect(result?.status).toBe("sent");
  });

  // Step 1's "réparation best-effort de la copie Sent manquante" is part of
  // the task's own definition of the `hasAcceptance` branch, not an
  // incidental detail -- a regression that silently dropped the repair call
  // would still report "sent" correctly (test 1 already covers that) but
  // would leave the mailbox's Sent folder permanently missing a copy the
  // journal says went out. These two cases make that repair itself
  // observable, not just its absence of effect on the reported status.
  it("repairs a missing Sent copy by moving the orphaned draft when one is found", async () => {
    const moveToSent = vi.fn().mockResolvedValue(undefined);
    const findByMessageId = vi.fn(async (role: string) =>
      role === "drafts" ? { uidValidity: 7, uid: 13 } : null,
    );
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(true),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      { findByMessageId, moveToSent },
    );

    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });

    expect(moveToSent).toHaveBeenCalledWith(7, 13, undefined);
    expect(result?.status).toBe("sent");
  });

  it("still reports sent when the repair move itself fails", async () => {
    const moveToSent = vi.fn().mockRejectedValue(new Error("IMAP down"));
    const findByMessageId = vi.fn(async (role: string) =>
      role === "drafts" ? { uidValidity: 7, uid: 13 } : null,
    );
    const provider = build(
      {
        hasAcceptance: vi.fn().mockResolvedValue(true),
        hasAttempt: vi.fn().mockResolvedValue(true),
      },
      { findByMessageId, moveToSent },
    );

    const result = await provider.reconcile({
      outreachId: "outreach-42",
      draftId: "7:13",
      mailboxId: "mbx-1",
    });

    expect(moveToSent).toHaveBeenCalledWith(7, 13, undefined);
    expect(result?.status).toBe("sent");
  });
});

describe("smtp_imap reconcile after a definite SMTP rejection", () => {
  it("no longer indefinitely reports accepted once a 4xx rejection has released the attempt", async () => {
    // Before this fix: every `smtp.submit` failure left `hasAttempt` true
    // forever, so `reconcile` returned `{status: "accepted"}` forever —
    // `send-service` turns that into `delivery_uncertain`, and nothing
    // ever changes on a later reconcile. This is that exact scenario, with
    // the fix in place: a 451 releases the attempt, so this second call
    // (simulating a later reconciliation pass) must see something other
    // than "accepted".
    const journal = new FakeSendJournal();
    const outreachId = "outreach-42";
    const draftMessageId = outreachMessageId(outreachId, "d.tld");
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
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      451,
      "451 4.7.1 Greylisted, try again later",
      "EENVELOPE",
    );
    const findByMessageId = vi.fn(async (role: string) =>
      role === "drafts" ? { uidValidity: 7, uid: 13 } : null,
    );
    const provider = new SmtpImapMailProvider(
      {
        fetchDraftSource: vi.fn().mockResolvedValue(draftMime),
        findByMessageId,
      } as never,
      { submit: vi.fn().mockRejectedValue(rejection) } as never,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({ draftId: "7:13", outreachId, mailboxId: "mbx-1" }),
    ).rejects.toBe(rejection);

    const result = await provider.reconcile({
      outreachId,
      draftId: null,
      mailboxId: "mbx-1",
    });

    expect(result?.status).not.toBe("accepted");
    expect(result).toEqual({ status: "drafted", draftId: "7:13" });
  });

  it("reports a permanent 5xx refusal as rejected, not delivery-uncertain", async () => {
    // The deliberate asymmetry: a 5xx will never succeed on retry, so
    // reopening the key would only let the same doomed content be
    // resubmitted. `reconcile` keeps routing this to manual review exactly
    // as it did before this fix — only the audit trail (proven at the
    // journal level, see `smtp-send-journal.ts`'s tests) is new.
    const journal = new FakeSendJournal();
    const outreachId = "outreach-43";
    const draftMessageId = outreachMessageId(outreachId, "d.tld");
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
    const rejection = new SmtpRejectionError(
      "Recipient command failed",
      550,
      "550 5.1.1 No such user",
      "EENVELOPE",
    );
    const provider = new SmtpImapMailProvider(
      { fetchDraftSource: vi.fn().mockResolvedValue(draftMime) } as never,
      { submit: vi.fn().mockRejectedValue(rejection) } as never,
      "mbx-1",
      "boite@d.tld",
      journal,
    );

    await expect(
      provider.sendDraft({ draftId: "7:13", outreachId, mailboxId: "mbx-1" }),
    ).rejects.toBe(rejection);

    const result = await provider.reconcile({
      outreachId,
      draftId: "7:13",
      mailboxId: "mbx-1",
    });

    expect(result).toEqual({
      status: "rejected",
      draftId: "7:13",
      responseCode: 550,
      response: "550 5.1.1 No such user",
      smtpErrorCode: "EENVELOPE",
      hardBounce: true,
    });
  });
});
