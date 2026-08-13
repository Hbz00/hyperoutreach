// No `import "server-only"` — this class is reachable from `trigger/tasks.ts`'s
// plain Node worker graph via `provider-bootstrap.ts` (Task 10), which has no
// `react-server` export condition active; see the same note in `imap-client.ts`.
import { outreachMessageId } from "@/lib/smtp-imap/message-id";
import {
  buildMime,
  extractMessageId,
  extractRecipient,
} from "@/lib/smtp-imap/mime";
import type { ImapAppendResult, ImapPort } from "@/lib/smtp-imap/imap-client";
import { SmtpRejectionError, type SmtpPort } from "@/lib/smtp-imap/smtp-client";
import type {
  MailDraft,
  MailDraftInput,
  MailProvider,
  MailReconciliation,
  SendDraftAcceptance,
} from "@/modules/mailboxes/mail-provider";

/**
 * Local acceptance-journal contract, backed by `workflowEvents` — concrete
 * implementation in `WorkflowEventsSendJournal`
 * (`smtp-send-journal.ts`), modeled on
 * `DatabaseMockMailProvider.sendDraft`/`reconcile`
 * (`mock-mail-provider.ts:145-194`). `sendDraft` (Task 9) consumes
 * `hasAcceptance`/`recordAttempt`/`recordAcceptance` — never `hasAttempt`,
 * which exists for `reconcile` (Task 10) to distinguish "never tried" from
 * "tried, outcome unknown" (delivery-uncertain), a distinction `sendDraft`
 * itself never needs to make.
 *
 * `recordAttempt` returns whether *this* call created the attempt record
 * (`true`) or one already existed (`false`) — not `void` — so `sendDraft`
 * can detect a concurrent or previously-crashed attempt and refuse to
 * submit a second time instead of guessing it is safe to retry. See
 * `sendDraft`'s own doc for how the boolean is used.
 *
 * `recordRejection` is `sendDraft`'s response to `smtp.submit` throwing a
 * `SmtpRejectionError` — a *definite* server refusal, as opposed to an
 * ambiguous failure (connection drop, timeout) which never calls it at all
 * and leaves the attempt exactly as `recordAttempt` left it. See
 * `SmtpRejectionDetails` and `sendDraft`'s own catch block for the full
 * 4xx/5xx rationale (design doc §8).
 */
export interface SendJournal {
  hasAttempt(messageKey: string): Promise<boolean>;
  hasAcceptance(messageKey: string): Promise<boolean>;
  getPermanentRejection(
    messageKey: string,
  ): Promise<SmtpRejectionDetails | null>;
  recordAttempt(messageKey: string): Promise<boolean>;
  recordAcceptance(messageKey: string): Promise<void>;
  recordRejection(
    messageKey: string,
    rejection: SmtpRejectionDetails,
  ): Promise<void>;
}

/**
 * What `sendDraft` learned from a `SmtpRejectionError` and hands to
 * `journal.recordRejection` — the journal never inspects `smtp.submit`'s
 * error itself, only this pre-digested record.
 *
 * `releaseAttempt` is the entire 4xx/5xx/EAUTH policy decision, made once by
 * `sendDraft` (see its own catch block for exactly how) and merely
 * *executed* by the journal:
 * - `true` for a `4xx` — transient, the server may accept the same message
 *   moments later (SMTP greylisting is the common real-world case).
 * - `true` for `EAUTH`, **regardless of its numeric `responseCode`** (often
 *   `535`, numerically a `5xx`): authentication fails before `MAIL FROM` is
 *   ever sent, so of every rejection this journal sees, this is the one
 *   with the *strongest* possible evidence the message itself was never
 *   submitted — nothing about *this message* caused the refusal, so
 *   nothing about it makes a retry futile the way a genuine `5xx` `RCPT
 *   TO`/`DATA` refusal does. The design doc (§8) treats an auth failure as
 *   a condition of the *mailbox* ("passe la boîte en `unavailable`"), not a
 *   verdict on this message; that mailbox-level transition is handled
 *   elsewhere (out of this journal's scope) — releasing the attempt here
 *   only ensures this one message doesn't stay wrongly quarantined once
 *   the mailbox's credentials are fixed or a transient auth hiccup passes.
 * - `false` for every other `5xx` — permanent; no retry will ever change
 *   the outcome, so reopening the key would only let the same doomed
 *   content be resubmitted, burning another attempt and masking the real
 *   problem instead of surfacing it for an operator.
 *
 * When the attempt is *not* released, it — and therefore `sendDraft`'s
 * refusal to resubmit, and `reconcile`'s `"accepted"`/delivery-uncertain
 * report — is left exactly as it was before this call; only the audit
 * trail is new. Either way `recordRejection` durably logs the rejection
 * (response code, raw response line, whether it was released) — today a
 * stuck delivery-uncertain message carries no information at all about
 * why; after this, the unreleased case in particular gets one.
 */
export type SmtpRejectionDetails = {
  responseCode: number;
  response?: string;
  /** `nodemailer`'s own error code (`EENVELOPE`, `EMESSAGE`, `EAUTH`, ...) —
   * carried through purely for the audit trail (`recordRejection`'s
   * payload); the release decision below is already made by the time this
   * is constructed. */
  smtpErrorCode?: string;
  releaseAttempt: boolean;
};

function toDraftId(result: { uidValidity: number; uid: number }): string {
  return `${result.uidValidity}:${result.uid}`;
}

const DRAFT_ID_PATTERN = /^(\d+):(\d+)$/;

/** Inverse of `toDraftId`. `sendDraft`/`reconcile` are handed the opaque
 * `${uidValidity}:${uid}` string `createDraft` returned, but `moveToSent`
 * and `fetchDraftSource` need the two numbers back apart. A malformed value
 * here means a caller bug (a `draftId` from another provider, a hand-typed
 * test fixture, DB corruption) — refused with a clear error rather than
 * guessed at, same doctrine as `domainOf` and `moveToSent`'s own
 * UIDVALIDITY-mismatch refusal. */
function parseDraftId(draftId: string): { uidValidity: number; uid: number } {
  const match = DRAFT_ID_PATTERN.exec(draftId);
  if (!match) {
    throw new Error(
      `Malformed draftId (expected "uidValidity:uid"): "${draftId}"`,
    );
  }
  return { uidValidity: Number(match[1]), uid: Number(match[2]) };
}

/** Extracts the domain from a full mailbox address (`user@domain` →
 * `domain`), for `outreachMessageId`, which wants a bare domain, not a full
 * address. Throws on a malformed address rather than silently building a
 * `Message-ID` with an empty/garbage domain — a provider is always
 * constructed with the mailbox's own real address (Task 10 wiring), so a
 * missing `@` here means a caller bug upstream, not a runtime condition to
 * degrade through. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    throw new Error(
      `Invalid mailbox address (expected "user@domain"): "${address}"`,
    );
  }
  return address.slice(at + 1);
}

/** `smtp_imap` counterpart to `MicrosoftGraphMailProvider`. Draft creation is
 * idempotent by construction: the `Message-ID` is deterministically derived
 * from `outreachId` (`outreachMessageId`), so a retry after a crash between
 * the IMAP `APPEND` and persisting `providerDraftId` finds the orphaned
 * draft instead of appending a second one (see `message-id.ts`). */
export class SmtpImapMailProvider implements MailProvider {
  readonly kind = "smtp_imap" as const;

  constructor(
    private readonly imap: ImapPort,
    private readonly smtp: SmtpPort,
    private readonly boundMailboxId: string,
    private readonly mailboxEmail: string,
    private readonly journal: SendJournal,
  ) {}

  private assertMailbox(mailboxId: string | null): void {
    if (mailboxId !== this.boundMailboxId) {
      throw new Error("smtp_imap provider mailbox binding mismatch");
    }
  }

  /** In authenticated SMTP the sender *is* the connected mailbox — there is
   * no other legitimate value once `input.sender` is absent. Falls back to
   * `mailboxEmail`, the connected mailbox's own address. Never throws and
   * never lets an empty string through to `buildMime`. */
  private resolveSender(sender: string | null): string {
    const trimmed = sender?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : this.mailboxEmail;
  }

  async createDraft(input: MailDraftInput): Promise<MailDraft> {
    this.assertMailbox(input.mailboxId);

    const messageId = outreachMessageId(
      input.outreachId,
      domainOf(this.mailboxEmail),
    );

    const existing = await this.imap.findByMessageId(
      "drafts",
      messageId,
      input.signal,
    );
    if (existing) {
      return { draftId: toDraftId(existing) };
    }

    const mime = buildMime(
      {
        sender: this.resolveSender(input.sender),
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        headers: input.headers,
      },
      messageId,
    );

    const appended = await this.imap.appendDraft(mime, input.signal);
    return { draftId: toDraftId(appended) };
  }

  /**
   * Submits the drafted message via SMTP and journals its acceptance —
   * **the** operation that must never run twice for the same outreach.
   * Sequence, normative, in this exact order:
   *
   * 1. `journal.hasAcceptance` → already sent, return without submitting
   *    anything (no IMAP call, no SMTP call — this is what makes a retry
   *    after a crash safe rather than a second send).
   * 2. Read the draft's raw source back out of IMAP (`fetchDraftSource`) —
   *    a read, not a commitment; failing here leaves no journal trace.
   * 3. `journal.recordAttempt` → `false` means an attempt already exists
   *    for this key with no matching acceptance (a concurrent `sendDraft`,
   *    or a previous run that crashed between the `250` and
   *    `recordAcceptance`). **Refuse to submit** rather than guess it is
   *    safe to retry — this call throws instead, leaving the ambiguity for
   *    `reconcile` (Task 10) to resolve. Never resubmit on a guess: the
   *    cost of a wrongly-blocked retry is a delay; the cost of a wrongly-
   *    allowed retry is a second email into the prospect's inbox.
   * 4. `smtp.submit` — resolves only on the server's `250`. If it throws a
   *    `SmtpRejectionError` (a definite `4xx`/`5xx`/`EAUTH` refusal — see
   *    `classifySmtpRejection`), `journal.recordRejection` is called before
   *    rethrowing: a `4xx`, or an `EAUTH` at any response code, releases
   *    the attempt so a later `sendDraft` can retry; any other `5xx` only
   *    logs the rejection and leaves the attempt in place, since no retry
   *    will ever change a permanent refusal (see `SmtpRejectionDetails` for
   *    the full rationale). Any other error
   *    (connection drop, timeout, no server verdict at all) is rethrown
   *    unchanged and never calls `recordRejection` — the attempt stays
   *    exactly as step 3 left it, because the server may have accepted the
   *    message before the connection was lost.
   * 5. `journal.recordAcceptance`, **immediately** after `submit` resolves,
   *    before any IMAP call — nothing that can throw is allowed between
   *    these two lines.
   * 6. `imap.moveToSent`, best-effort: swallowed in its own `try/catch` so
   *    a classification failure can never flip a message that was already
   *    accepted by the SMTP server back into "not sent".
   *
   * The IMAP Drafts/Sent state is never consulted to decide whether a send
   * already happened — only `journal.hasAcceptance` is authoritative (see
   * the design doc, §3.1: "L'état des dossiers IMAP n'est jamais
   * autoritaire pour le statut d'envoi.").
   */
  async sendDraft(input: {
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<SendDraftAcceptance> {
    this.assertMailbox(input.mailboxId);

    // Deterministic from `outreachId` alone — the same value `createDraft`
    // derived and, crucially, the same value `reconcile` (Task 10) can
    // recompute from `outreachId` with no `draftId` on hand at all. Using
    // it as the journal key is what lets `hasAcceptance` survive a crash
    // that lost every other piece of local state.
    const messageId = outreachMessageId(
      input.outreachId,
      domainOf(this.mailboxEmail),
    );

    if (await this.journal.hasAcceptance(messageId)) {
      return { status: "accepted" };
    }

    const { uidValidity, uid } = parseDraftId(input.draftId);

    const mime = await this.imap.fetchDraftSource(
      uidValidity,
      uid,
      input.signal,
    );
    const mimeMessageId = extractMessageId(mime);
    if (mimeMessageId !== messageId) {
      throw new Error(
        `Refusing to submit draft ${input.draftId}: Message-ID mismatch ` +
          `(expected ${messageId}, found ${mimeMessageId ?? "none"})`,
      );
    }
    const recipient = extractRecipient(mime);
    if (!recipient) {
      throw new Error(
        `Draft ${input.draftId} carries no "To" header to submit to`,
      );
    }

    const isFirstAttempt = await this.journal.recordAttempt(messageId);
    if (!isFirstAttempt) {
      throw new Error(
        `A send attempt for ${messageId} is already recorded with no matching acceptance; ` +
          `refusing to submit a second time — this is the delivery-uncertain case reconciliation must resolve`,
      );
    }

    try {
      await this.smtp.submit(
        mime,
        { from: this.mailboxEmail, to: recipient },
        input.signal,
      );
    } catch (error) {
      if (error instanceof SmtpRejectionError) {
        // A definite server refusal: the message provably was not
        // accepted. A `4xx` is transitory (design doc §8) — greylisting on
        // a first send from a new client is the common real case — so the
        // attempt is released for a later retry. `EAUTH` releases too,
        // *regardless* of its numeric response code (often `535`,
        // numerically a `5xx`): it fires before `MAIL FROM`, so nothing
        // about this specific message caused it, unlike a genuine `5xx`
        // `RCPT TO`/`DATA` refusal, which is permanent and left in place —
        // no retry will ever succeed, so reopening the key would only let
        // the same doomed content be resubmitted and would mask the
        // underlying problem instead of surfacing it for an operator (see
        // `SmtpRejectionDetails` for the full rationale on both). Either
        // way the rejection itself is now on record, which it never was
        // before this call existed.
        await this.journal.recordRejection(messageId, {
          responseCode: error.responseCode,
          response: error.response,
          smtpErrorCode: error.smtpErrorCode,
          releaseAttempt:
            error.responseCode < 500 || error.smtpErrorCode === "EAUTH",
        });
      }
      // Ambiguous failures (connection drop, timeout, no server verdict)
      // fall straight through here without ever calling
      // `recordRejection` — the attempt stays exactly as `recordAttempt`
      // left it, because the server may have accepted the message before
      // the connection was lost. Never resubmit on a guess (see step 3).
      throw error;
    }

    // Immediately after the `250` — nothing between this line and the one
    // above may throw. The Sent copy below is best-effort precisely so
    // that it can never retroactively undo this write.
    await this.journal.recordAcceptance(messageId);

    try {
      await this.imap.moveToSent(uidValidity, uid, input.signal);
    } catch {
      // Best-effort: the send already happened and is already journaled.
      // A failed Drafts→Sent move must never affect the reported send
      // status — see the design doc's §3.1 rationale for why IMAP folder
      // state is never authoritative here.
    }

    return { status: "accepted" };
  }

  /**
   * Strict, ordered precedence — see the design doc's §3.1/§3.2. **IMAP
   * folder state is never authoritative for send status; it is consulted
   * only when the local journal has nothing to say at all (step 3 below).**
   * Simplifying this order (e.g. trusting a Drafts/Sent search before the
   * journal, or collapsing steps 2/3) reopens the double-send hole Task 9's
   * journal exists to close — see the third unit test, the guard against
   * exactly that regression.
   *
   * 1. `journal.hasAcceptance` → the SMTP server already returned `250`.
   *    Report `"sent"` unconditionally and repair a missing Sent copy
   *    best-effort (`reportSent`) — a failed repair must never change the
   *    reported status, since the send already happened and is already
   *    journaled.
   * 2. Otherwise `journal.hasAttempt` → an attempt was recorded with *no*
   *    matching acceptance: a crash between `smtp.submit` resolving and
   *    `recordAcceptance`, or a still-in-flight concurrent attempt. The
   *    SMTP outcome is genuinely unknown — reporting `"drafted"` here would
   *    let a caller draft/send it again, which is precisely the double
   *    send this whole mechanism exists to prevent. Report `"accepted"`
   *    instead; `send-service` turns that into `delivery_uncertain`, which
   *    never auto-retries.
   * 3. Otherwise nothing was ever attempted through this journal — the only
   *    remaining evidence is IMAP folder state itself, used here purely as
   *    a last resort. **Sent is checked before Drafts.**
   *
   *    This branch is reached only when the journal knows nothing at all —
   *    including after a journal reset, or for a message this provider
   *    never itself sent — so the folder state consulted here was not
   *    necessarily produced by this class's own `sendDraft`/`moveToSent`.
   *    "`moveToSent` is atomic, so a message can never be in both folders
   *    at once" is a true property of *this code's own* sends, but it does
   *    not hold for what a server does on its own: the design doc names
   *    Zimbra (§10) as auto-classifying some sends into Sent server-side,
   *    while `moveToSent`'s best-effort nature (`sendDraft`, step 6) can
   *    simultaneously leave an orphaned copy sitting in Drafts. Checking
   *    Drafts first would report `"drafted"` for that orphan; the
   *    deterministic Message-ID (`message-id.ts`) does not save the next
   *    call, because the orphaned draft *is* a legitimate, exact match —
   *    `send-service` would persist that `draftId`, transition to
   *    `"sending"`, and call `sendDraft`, which submits. Checking Sent
   *    first closes that path.
   *
   * `findByMessageId` failures **propagate** in this branch — a failed
   * SEARCH misread as "not found" would be the same defect already fixed on
   * `ImapClient.status`/`searchByMessageId` (Task 7): unlike the
   * best-effort repair in `reportSent`, IMAP state genuinely *is* the
   * decision input here, so a failed read must fail `reconcile`, not
   * silently degrade to `null`.
   */
  async reconcile(input: {
    outreachId: string;
    draftId: string | null;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<MailReconciliation> {
    this.assertMailbox(input.mailboxId);

    // Same derivation `sendDraft` uses, from `outreachId` and the mailbox's
    // own domain alone — must stay byte-identical, or this queries a
    // journal key `sendDraft` never wrote and concludes "never attempted"
    // on a message that already went out.
    const messageId = outreachMessageId(
      input.outreachId,
      domainOf(this.mailboxEmail),
    );

    if (await this.journal.hasAcceptance(messageId)) {
      return this.reportSent(messageId, input.draftId, input.signal);
    }

    const rejection = await this.journal.getPermanentRejection(messageId);
    if (rejection) {
      const draftId =
        input.draftId ?? (await this.recoverDraftId(messageId, input.signal));
      return {
        status: "rejected",
        draftId,
        responseCode: rejection.responseCode,
        ...(rejection.response ? { response: rejection.response } : {}),
        ...(rejection.smtpErrorCode
          ? { smtpErrorCode: rejection.smtpErrorCode }
          : {}),
        hardBounce:
          rejection.smtpErrorCode === "EENVELOPE" &&
          /\b5\.1\.\d{1,3}\b/.test(rejection.response ?? ""),
      };
    }

    if (await this.journal.hasAttempt(messageId)) {
      const draftId =
        input.draftId ?? (await this.recoverDraftId(messageId, input.signal));
      return { status: "accepted", draftId };
    }

    const sentMatch = await this.imap.findByMessageId(
      "sent",
      messageId,
      input.signal,
    );
    if (sentMatch) {
      return {
        status: "sent",
        draftId: toDraftId(sentMatch),
        providerMessageId: `imap:${toDraftId(sentMatch)}`,
        internetMessageId: messageId,
        conversationId: null,
      };
    }

    const draftMatch = await this.imap.findByMessageId(
      "drafts",
      messageId,
      input.signal,
    );
    if (draftMatch) {
      return { status: "drafted", draftId: toDraftId(draftMatch) };
    }

    return null;
  }

  /** Recovers a `draftId` string when the caller's own `draftId` is `null`
   * (an orphaned "accepted" case reconstructed from `outreachId` alone).
   * Consults IMAP purely to *name* the draft, never to decide status.
   *
   * Unlike `reportSent`'s repair lookups, a failure or a miss here is **not**
   * swallowed into a synthetic fallback: `reconcile`'s `"accepted"` branch
   * flows straight into `messages.providerDraftId`
   * (`send-service.ts`, the `reconciliation.draftId` writes), a column whose
   * contract everywhere else in this file is `` `${uidValidity}:${uid}` ``
   * (`parseDraftId`). Returning `messageId` — a `Message-ID` string — here
   * used to satisfy the type system by lying: it would pass a value that
   * looks like a draftId into that column, only for a later legitimate
   * caller (`sendDraft`, a manual recovery path) to have `parseDraftId`
   * reject it as malformed. Same "refuse rather than guess" doctrine as
   * `parseDraftId`/`domainOf`/`moveToSent`'s own UIDVALIDITY refusal: a
   * `reconcile` call that cannot produce a real draftId here throws instead,
   * which its callers already treat as a legitimate `PROVIDER_ERROR`
   * outcome (`reconcileProvider`'s own `try/catch`) — never a corrupted
   * `providerDraftId`. */
  private async recoverDraftId(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const draftMatch = await this.imap.findByMessageId(
      "drafts",
      messageId,
      signal,
    );
    if (draftMatch) return toDraftId(draftMatch);
    throw new Error(
      `Cannot resolve a draftId for ${messageId}: a send attempt is recorded but no draftId ` +
        `was supplied and no matching draft was found in IMAP Drafts`,
    );
  }

  /** Builds the `"sent"` reconciliation once `journal.hasAcceptance` has
   * already settled the question, attempting a best-effort repair of a
   * missing Sent copy first. Every IMAP call here is wrapped: a failed
   * lookup or a failed repair must never change the reported status —
   * unlike `reconcile`'s own step 3, IMAP state is not the decision input
   * in this method, only a courtesy cleanup on top of a status the journal
   * already decided.
   *
   * `draftId` and `providerMessageId` are deliberately derived from the
   * **same** single identifier, computed once below — mirroring
   * `MicrosoftGraphMailProvider.reconcile`'s `"sent"` branch, where both
   * fields are literally `message.id` (Graph keeps one immutable id across
   * the draft→sent transition). IMAP has no such single id, so this
   * resolves one explicitly, in priority order: the freshly-discovered Sent
   * location (the most authoritative thing this method learns) first, the
   * caller-supplied `draftId` next, the deterministic `messageId` last.
   * Sourcing the two fields independently (Sent location for one,
   * caller-supplied Drafts reference for the other) would let the response
   * carry two UIDs from two different folders in the same object — nothing
   * downstream expects that, and nothing here needs it. */
  private async reportSent(
    messageId: string,
    fallbackDraftId: string | null,
    signal?: AbortSignal,
  ): Promise<MailReconciliation> {
    let sentLocation: ImapAppendResult | null = null;
    try {
      sentLocation = await this.imap.findByMessageId("sent", messageId, signal);
    } catch {
      // Best-effort repair-check: never let a failed lookup here block
      // reporting "sent", which the journal has already settled.
    }

    if (!sentLocation) {
      try {
        const draftLocation = await this.imap.findByMessageId(
          "drafts",
          messageId,
          signal,
        );
        if (draftLocation) {
          await this.imap.moveToSent(
            draftLocation.uidValidity,
            draftLocation.uid,
            signal,
          );
        }
      } catch {
        // Best-effort repair: the send already happened and is already
        // journaled — a failed repair must never affect the reported
        // status. See the design doc's §3.1 rationale (also cited on
        // `sendDraft`'s own `moveToSent` call).
      }
    }

    const draftId = sentLocation
      ? toDraftId(sentLocation)
      : (fallbackDraftId ?? messageId);

    return {
      status: "sent",
      draftId,
      providerMessageId: `imap:${draftId}`,
      internetMessageId: messageId,
      conversationId: null,
    };
  }
}
