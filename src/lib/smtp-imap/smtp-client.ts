// No `import "server-only"` — see the same note in `imap-client.ts`: this
// module is reachable from `trigger/tasks.ts`'s plain Node worker graph via
// `provider-bootstrap.ts` (Task 10), where `server-only` throws unconditionally.
import nodemailer from "nodemailer";

import { throwIfAborted } from "@/lib/smtp-imap/abort";
import type { MailboxCredentials } from "@/lib/smtp-imap/imap-client";
import { extractMessageId } from "@/lib/smtp-imap/mime";
import type { MailboxTransport } from "@/lib/smtp-imap/transport-config";

export type SmtpEnvelope = {
  from: string;
  to: string;
};

export type SmtpSubmitResult = {
  messageId: string;
  response: string;
};

/**
 * Thrown by `submit` in place of the raw `nodemailer` error when the SMTP
 * server issued a **definite** refusal of this specific message — a
 * numbered response (`4xx`/`5xx`) tied to a command in the transaction
 * (`MAIL FROM`, `RCPT TO`, `DATA`, or authentication), as opposed to a
 * connection-level failure (dropped socket, timeout, DNS) where the
 * server's verdict, if any, is unknown. See `classifySmtpRejection` for how
 * `submit` tells the two apart, and `SmtpImapMailProvider.sendDraft` for
 * why the distinction is load-bearing: only a `SmtpRejectionError` is safe
 * to turn into a released send attempt.
 */
export class SmtpRejectionError extends Error {
  /** The server's own numbered response, e.g. `451` or `550`. Always in
   * `[400, 600)` — `classifySmtpRejection` never constructs one otherwise. */
  readonly responseCode: number;
  /** The raw server response line, when `nodemailer` captured one. */
  readonly response?: string;
  /** `nodemailer`'s own error classification (`EENVELOPE`, `EMESSAGE`,
   * `EAUTH`, ...) — kept for diagnostics, not decision-making: the
   * `responseCode` is what `sendDraft` acts on. */
  readonly smtpErrorCode?: string;

  constructor(
    message: string,
    responseCode: number,
    response?: string,
    smtpErrorCode?: string,
  ) {
    super(message);
    this.name = "SmtpRejectionError";
    this.responseCode = responseCode;
    this.response = response;
    this.smtpErrorCode = smtpErrorCode;
  }
}

/** `nodemailer`'s `SMTPConnection` error codes for a connection-level
 * failure — the socket never got, or never finished receiving, a reply to
 * attribute to a specific command (`smtp-connection/index.js`: socket
 * `'error'` events, connect/greeting timeouts, DNS failures all format
 * through `_onError`/`_formatError` with one of these three `type`s).
 *
 * One of `_onError`'s callers is a genuine trap for a responseCode-based
 * check alone: `_onClose` (`smtp-connection/index.js` ~L990-994), when the
 * socket drops mid-transaction, decodes whatever partial line is sitting in
 * its read buffer and — if that fragment happens to start with a `4` or `5`
 * digit — passes it through as the `response` argument, which still
 * populates `err.responseCode`, *while `err.code` stays `'ECONNECTION'`*.
 * That fragment is a race between the disconnect and an in-flight reply,
 * not a completed server verdict, so it must classify as ambiguous exactly
 * like every other `ECONNECTION`/`ETIMEDOUT`/`ESOCKET` — hence checking
 * `code` here is not redundant with the `responseCode` check below; dropping
 * either one reopens this exact edge case.
 *
 * Every other error `type` `_formatError` can produce (`EENVELOPE`,
 * `EMESSAGE`, `EAUTH`, `EPROTOCOL`, `ETLS`, ...) is, by construction, a
 * *complete* server reply attributed to a specific command: `EENVELOPE`
 * (`MAIL FROM`/`RCPT TO` refused) and `EAUTH` fire before the message body
 * is ever sent; `EMESSAGE` fires *after* the full body was transmitted, on
 * the server's own final "did you accept what I just sent" response
 * (`_actionSMTPStream`/`_actionDATA`) — later in the transaction than the
 * other two, but still a full round-trip reply, never a guess about one
 * still in flight. A `responseCode` attached to any of these is therefore
 * always attributable: the message was provably never accepted by *this*
 * transaction, whatever the specific `code` — the one thing a responseCode
 * here can *not* tell you, and which `sendDraft` handles separately, is
 * whether the same message is safe to retry (see `SmtpRejectionDetails`'s
 * `EAUTH` carve-out). */
const AMBIGUOUS_SMTP_ERROR_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
]);

/**
 * Classifies a `nodemailer`/`SMTPConnection` submit failure as a definite
 * server rejection (returns the responseCode/response/code triple) or
 * ambiguous (returns `null`) — never guesses in the ambiguous direction: a
 * missing/malformed `responseCode`, an out-of-range one, or one paired with
 * a connection-level `code` all return `null`. Exported standalone so tests
 * can feed it fabricated, nodemailer-shaped error objects directly, without
 * opening a real (or fake) SMTP connection.
 */
export function classifySmtpRejection(
  error: unknown,
): { responseCode: number; response?: string; smtpErrorCode?: string } | null {
  if (!(error instanceof Error)) return null;
  const err = error as Error & {
    responseCode?: unknown;
    response?: unknown;
    code?: unknown;
  };
  const { responseCode } = err;
  if (typeof responseCode !== "number" || !Number.isInteger(responseCode))
    return null;
  if (responseCode < 400 || responseCode >= 600) return null;
  if (typeof err.code === "string" && AMBIGUOUS_SMTP_ERROR_CODES.has(err.code))
    return null;
  return {
    responseCode,
    response: typeof err.response === "string" ? err.response : undefined,
    smtpErrorCode: typeof err.code === "string" ? err.code : undefined,
  };
}

/** The public surface `SmtpClient` exposes. Exists for the same reason as
 * `ImapPort`: a real interface a test double can be checked against,
 * instead of an untyped `as never` mock.
 *
 * `signal` is preflight-only here, unlike `ImapPort`'s methods: `submit`
 * checks it before starting and rejects immediately if already aborted, but
 * cannot bound the in-flight send. `nodemailer`'s top-level transport
 * `close()` only clears OAuth2 listeners and emits a `'close'` event nothing
 * listens for (`smtp-transport/index.js`); the real `SMTPConnection` is
 * created fresh inside `send()`, per call, and is never reachable from the
 * transport handle `submit` holds. There is no supported way to cancel a
 * `sendMail({ raw })` already in flight. */
export interface SmtpPort {
  submit(
    mime: string,
    envelope: SmtpEnvelope,
    signal?: AbortSignal,
  ): Promise<SmtpSubmitResult>;
  /** Proves the endpoint is reachable and the credentials are accepted —
   * connect, negotiate TLS, authenticate — without ever opening a mail
   * transaction (no `MAIL FROM`/`RCPT TO`/`DATA`). See `SmtpClient.verify`
   * for what it delegates to and why that guarantees no message is sent. */
  verify(signal?: AbortSignal): Promise<void>;
}

/** Same explicit-timeout reasoning as `ImapClient` — this wrapper opens one
 * connection per `submit`, so it must not be able to hang indefinitely on a
 * stalled handshake. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_GREETING_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

function toSecurityOptions(security: "tls" | "starttls"): {
  secure: boolean;
  requireTLS?: boolean;
} {
  // Same non-negotiable-encryption rule as the IMAP side: `tls` is already
  // encrypted at connect time; `starttls` (the school's port 587) must
  // upgrade before anything is sent — `requireTLS` makes that mandatory
  // rather than opportunistic, so a server that can't STARTTLS fails the
  // connection instead of silently sending in the clear.
  return security === "tls"
    ? { secure: true }
    : { secure: false, requireTLS: true };
}

/**
 * Thin wrapper around `nodemailer`. Takes an already-assembled RFC 5322
 * MIME source (from `buildMime`) rather than building the message itself —
 * this client only submits it and reports the server's acceptance.
 */
export class SmtpClient implements SmtpPort {
  constructor(
    private readonly transport: MailboxTransport,
    private readonly credentials: MailboxCredentials,
  ) {}

  private createTransport() {
    return nodemailer.createTransport({
      host: this.transport.smtp.host,
      port: this.transport.smtp.port,
      ...toSecurityOptions(this.transport.smtp.security),
      auth: {
        user: this.credentials.user,
        pass: this.credentials.pass,
      },
      connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
      greetingTimeout: DEFAULT_GREETING_TIMEOUT_MS,
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
    });
  }

  /**
   * Submits `mime` for delivery to `envelope`. Resolves only once the
   * server has accepted the message (SMTP `250`) for the envelope
   * recipient; `nodemailer` itself resolves as soon as *any* recipient is
   * accepted, so an empty `accepted` list or a non-empty `rejected` list is
   * turned into a thrown error here — the caller (Task 9's acceptance
   * journal) treats a resolved `submit` as "safe to never retry".
   *
   * `signal` is checked once, up front — see `SmtpPort` for why it cannot
   * also bound the send once it has started.
   */
  async submit(
    mime: string,
    envelope: SmtpEnvelope,
    signal?: AbortSignal,
  ): Promise<SmtpSubmitResult> {
    throwIfAborted(signal);
    const messageId = extractMessageId(mime);
    if (!messageId) {
      throw new Error("Cannot submit a MIME source with no Message-ID header");
    }

    const transporter = this.createTransport();
    try {
      const info = await transporter.sendMail({
        envelope: { from: envelope.from, to: [envelope.to] },
        raw: mime,
      });
      if (info.accepted.length === 0 || info.rejected.length > 0) {
        throw new Error(
          `SMTP server did not accept ${envelope.to}: ${JSON.stringify(info.rejected)}`,
        );
      }
      // `sendMail({ raw })` never parses the message it was handed — the
      // underlying `MimeNode` has no headers of its own, so nodemailer
      // fabricates a brand-new random `info.messageId` on every call
      // (node_modules/nodemailer/lib/mime-node/index.js `messageId()`,
      // surfaced via smtp-transport/index.js). The message actually
      // transmitted keeps the `Message-ID` `buildMime` wrote into `mime`,
      // so that is the value reported here — `info.messageId` is discarded
      // because it names nothing: not the sent message, not anything
      // findable later. Returning it would hand the deterministic-id
      // dedupe this feature depends on an id that exists nowhere.
      return { messageId, response: info.response };
    } catch (error) {
      // Re-classify before the caller ever sees this error: a definite
      // server rejection becomes a `SmtpRejectionError` carrying the
      // response code the caller (`sendDraft`) needs to decide whether the
      // send attempt is safe to release; anything ambiguous (connection
      // drop, timeout, ...) passes through unchanged — see
      // `classifySmtpRejection` for the full rationale.
      const rejection = classifySmtpRejection(error);
      if (rejection) {
        throw new SmtpRejectionError(
          error instanceof Error ? error.message : String(error),
          rejection.responseCode,
          rejection.response,
          rejection.smtpErrorCode,
        );
      }
      throw error;
    } finally {
      transporter.close();
    }
  }

  /**
   * Proves the mailbox works end-to-end on the SMTP side, for Task 12's
   * connection verification — connect, negotiate TLS (mandatory per
   * `toSecurityOptions`, exactly as `submit` requires), authenticate, then
   * disconnect, *without* ever entering a mail transaction. Delegates to
   * `nodemailer`'s own `Transporter.verify()` (`smtp-transport/index.js`):
   * reading that implementation confirms it opens a raw `SMTPConnection`,
   * calls `connection.connect()`, then — only when auth is configured and
   * the server advertises it — `connection.login(...)`, then `quit()`. It
   * never calls `sendMail`/`MAIL FROM`/`RCPT TO`/`DATA` on any path, so a
   * verification pass can never submit a message, and a verification
   * failure can never have submitted one either.
   *
   * Reuses `classifySmtpRejection` on failure so a bad-credentials verdict
   * from this path carries the same `SmtpRejectionError` shape (`code`,
   * `responseCode`, `response`) that `submit`'s callers already know how to
   * read — one rejection vocabulary for the whole class, not two.
   */
  async verify(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const transporter = this.createTransport();
    try {
      await transporter.verify();
    } catch (error) {
      const rejection = classifySmtpRejection(error);
      if (rejection) {
        throw new SmtpRejectionError(
          error instanceof Error ? error.message : String(error),
          rejection.responseCode,
          rejection.response,
          rejection.smtpErrorCode,
        );
      }
      throw error;
    } finally {
      transporter.close();
    }
  }
}
