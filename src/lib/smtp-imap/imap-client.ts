// Deliberately no `import "server-only"` here (unlike an earlier revision of
// this file): this module is reachable from `trigger/tasks.ts`'s plain Node
// worker graph via `provider-bootstrap.ts` (Task 10), which has no
// `react-server` export condition active — `server-only` throws unconditionally
// there, not just in a client bundle. Same split as `lib/db/client-core.ts`
// (unmarked, worker-safe) vs. `lib/db/client.ts` (the `server-only`-marked
// Next.js-only wrapper): this file is the "core" implementation. It stays
// safe from accidental client-bundle inclusion regardless, since `imapflow`
// itself pulls in Node builtins (`net`/`tls`) that fail a browser bundle on
// their own.
import { ImapFlow } from "imapflow";

import { throwIfAborted } from "@/lib/smtp-imap/abort";
import { extractMessageId } from "@/lib/smtp-imap/mime";
import type { MailboxTransport } from "@/lib/smtp-imap/transport-config";

/** Credentials for the mailbox, kept separate from `MailboxTransport` — the
 * transport schema (Task 5) carries connection shape, not secrets. Callers
 * decrypt `encrypted_password` and pass the plaintext in here. */
export type MailboxCredentials = {
  user: string;
  pass: string;
};

/** Minimal shape `resolveFolderRoles` needs from a listed mailbox. Deliberately
 * not `imapflow`'s `ListResponse` — this keeps the function (and every public
 * `ImapClient` signature below) free of any `imapflow` type, so the Task 8
 * provider can double `ImapClient` without importing the library at all. */
export type ImapFolderDescriptor = {
  path: string;
  specialUse?: string;
};

export type ImapFolderRoles = {
  drafts: string;
  sent: string;
};

/** The set of folder roles callers may search by, rather than a raw path —
 * see `ImapPort.findByMessageId` for why a role (not a string path) is the
 * public contract. */
export type ImapFolderRole = keyof ImapFolderRoles;

export type ImapAppendResult = {
  uidValidity: number;
  uid: number;
};

/** One page of messages fetched from a UID range. Every field is a plain
 * value — no `imapflow` `FetchMessageObject`, `Envelope`, or `Address` type
 * leaks through, matching the no-imapflow-in-public-signatures constraint.
 * `envelope` is a cheap, structured preview (imapflow's own ENVELOPE parse,
 * itself derived from the sender-controlled `Date:`/`From:`/... headers);
 * `internalDate` is the server's own arrival timestamp (IMAP INTERNALDATE),
 * immune to a sender's clock/spoofing, for a caller that needs a trustworthy
 * `receivedAt`; `body` is the *full* raw RFC 5322 source as a `Buffer` —
 * never transcoded to a JS string here (see `fetchRange`'s doc comment for
 * why a charset-blind `.toString("utf-8")` corrupts non-UTF-8 mail) — headers
 * included, so a real MIME parser downstream can see the top-level
 * `Content-Type` boundary it needs. */
export type ImapFetchedMessage = {
  uid: number;
  envelope: {
    messageId: string | null;
    subject: string | null;
    from: string | null;
    to: string | null;
    date: Date | null;
  };
  internalDate: Date | null;
  body: Buffer;
};

/**
 * Thrown by every `ImapClient` method in place of the raw `imapflow` error
 * when the connection failed to *authenticate* — as opposed to any other
 * connect/command failure (DNS, TCP, TLS, a protocol confusion, rate
 * limiting, ...), where the server's verdict on the credentials, if any, is
 * unknown. See `classifyImapAuthFailure` for how `withConnection` tells the
 * two apart, and `SmtpRejectionError` (`smtp-client.ts`) for the SMTP-side
 * counterpart this mirrors — same task, same "definite vs ambiguous"
 * doctrine, different protocol.
 */
export class ImapAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapAuthenticationError";
  }
}

/**
 * Thrown by `resolveFolderRoles` when the connection *authenticated fine*
 * but the Drafts/Sent folders could not be identified by special-use flag or
 * conventional name — a structurally different failure than
 * `ImapAuthenticationError` (Task 12's connection verification needs to tell
 * the two apart: a rejected login and a mailbox whose folders are simply
 * named something this code doesn't recognize — e.g. a French Zimbra's
 * "Brouillons"/"Envoyés" outside `DRAFTS_CONVENTIONAL_NAMES`/
 * `SENT_CONVENTIONAL_NAMES` — call for different operator guidance). Never
 * thrown by `withConnection`'s own `catch` (that path only ever produces
 * `ImapAuthenticationError` or the raw, unclassified error) — only by
 * `resolveFolderRoles` itself, always *after* `client.connect()` already
 * succeeded.
 */
export class ImapFolderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapFolderResolutionError";
  }
}

/**
 * `imapflow`'s own error codes that mean "a command definitely failed, but
 * not because the credentials are wrong" — read from
 * `node_modules/imapflow/lib/imap-flow.js`'s `settleRequest` (the `NO`/`BAD`
 * tagged-response handler), not from the library's docs, per this task's own
 * methodology. `ETHROTTLE` is the one that matters here: Microsoft 365 (and
 * others) can answer a `NO`/`BAD` to *any* command, including `LOGIN`/
 * `AUTHENTICATE`, with a rate-limit backoff instead of a real verdict on the
 * password — `settleRequest` detects this by pattern-matching the response
 * text and tags it with this code before the auth command handlers below
 * ever see it. A rate limit says nothing about whether the credentials are
 * correct; revoking the mailbox on one would be exactly backwards — it
 * should back off and retry, not get quarantined.
 */
const AMBIGUOUS_IMAP_ERROR_CODES = new Set(["ETHROTTLE"]);

/**
 * RFC 5530 response codes that describe a *transient server-side condition*
 * rather than a verdict on the credentials — carried on `err.serverResponseCode`
 * (see the field's own note below), not `err.code` (`AMBIGUOUS_IMAP_ERROR_CODES`
 * above is a distinct, `imapflow`-internal vocabulary). `UNAVAILABLE`: the
 * auth backend itself is momentarily down (the IMAP-side counterpart of
 * Postfix's SMTP `454 4.7.0`). `SERVERBUG`: the server hit an internal error
 * processing the command, not a rejection of the credentials. `INUSE`: the
 * mailbox/resource is locked by another session — again nothing about the
 * password. Deliberately excludes `EXPIRED`: an expired password/token *is*
 * a real credentials problem (not "try again later") and must still revoke
 * the mailbox — a caller retrying an expired credential in a loop is
 * exactly the failure mode this whole classifier exists to stop.
 */
const TRANSIENT_IMAP_RESPONSE_CODES = new Set([
  "UNAVAILABLE",
  "SERVERBUG",
  "INUSE",
]);

/**
 * Classifies a caught `imapflow` error as a *definite* authentication
 * failure (`true`) or ambiguous (`false`) — never guesses ambiguous away.
 * Exported standalone so tests can feed it fabricated, imapflow-shaped error
 * objects directly, without opening a real (or fake) IMAP connection.
 *
 * The trap this exists to avoid, found by reading
 * `node_modules/imapflow/lib/commands/login.js` and
 * `.../commands/authenticate.js` (both the classic `LOGIN` command and every
 * SASL mechanism — `PLAIN`, `LOGIN`, OAuth — funnel through one of these two
 * files' `catch` blocks): **both unconditionally set
 * `err.authenticationFailed = true` on *any* error the underlying
 * `connection.exec()` call rejects with — including a connection dropping
 * mid-command, before any server reply ever arrived.** `imapflow`'s own
 * `authenticationFailed` flag is therefore not sufficient on its own; relying
 * on it alone would misclassify a network failure that merely happened
 * *during* a login attempt as a definite bad-password verdict.
 *
 * The same `catch` blocks also reassign `err.response` to
 * `getErrorText(err.response)`'s result (`tools.js`) — a non-empty string
 * only when there was an actual parsed tagged response to render text from,
 * `false` when the promise rejected before any reply arrived at all. That
 * reassigned value, not the raw pre-existing `err.response`, is what
 * `login.js`/`authenticate.js` leave on the error by the time it reaches
 * this code — so requiring it to be a non-empty string is what tells "the
 * server said no" apart from "the connection broke before any reply came
 * back", exactly the same shape of distinction `classifySmtpRejection`
 * (`smtp-client.ts`) draws for SMTP via `responseCode`.
 *
 * Deliberately does **not** require a structured IMAP response code (e.g.
 * `[AUTHENTICATIONFAILED]`, RFC 5530) to be present: many real servers
 * (Dovecot, Zimbra) answer a plain `NO Login failed` with no bracketed code
 * at all, which is still a complete, attributable "no" — requiring a
 * structured code would silently miss the common case.
 *
 * When a structured code *is* present, though, it is not ignored: the same
 * `login.js`/`authenticate.js` catch blocks (via `tools.js`'s shared
 * enhancement logic) set `err.serverResponseCode` from the bracketed RFC
 * 5530 token (`getStatusCode`) — **before** `err.response` is reassigned to
 * its rendered text form above, so both fields are present together by the
 * time this function runs. A handful of those codes describe a transient
 * server condition, not a credentials verdict (see
 * `TRANSIENT_IMAP_RESPONSE_CODES`); those are excluded here for the same
 * reason `ETHROTTLE` is.
 */
export function classifyImapAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & {
    authenticationFailed?: unknown;
    response?: unknown;
    code?: unknown;
    serverResponseCode?: unknown;
  };
  if (err.authenticationFailed !== true) return false;
  if (typeof err.response !== "string" || err.response.length === 0)
    return false;
  if (typeof err.code === "string" && AMBIGUOUS_IMAP_ERROR_CODES.has(err.code))
    return false;
  if (
    typeof err.serverResponseCode === "string" &&
    TRANSIENT_IMAP_RESPONSE_CODES.has(err.serverResponseCode)
  ) {
    return false;
  }
  return true;
}

/**
 * The public surface `ImapClient` exposes, with zero `imapflow` types in it.
 * Exists so callers (the Task 8/9/10 provider, Task 11's inbound source) can
 * type their test doubles against a real interface instead of `as never` —
 * a verified double is the only thing that can catch drift between this
 * class and its stand-ins, since no test here talks to a real server.
 */
export interface ImapPort {
  resolveFolders(signal?: AbortSignal): Promise<ImapFolderRoles>;
  appendDraft(mime: string, signal?: AbortSignal): Promise<ImapAppendResult>;
  /** Searches by folder *role*, not a raw path — `"drafts"`/`"sent"` resolve
   * to `transport.folders.drafts`/`.sent` internally, the same paths
   * `appendDraft`/`moveToSent` write to. This is deliberate: a caller that
   * searched a literal path (e.g. a hardcoded `"Drafts"`) could silently
   * diverge from the real, possibly localized or namespaced folder name
   * (`"Brouillons"`, `"INBOX.Drafts"`) that `appendDraft` actually writes
   * to — the search would then never find what a retry is about to
   * duplicate. Resolving through the same role keeps the two in sync by
   * construction. */
  findByMessageId(
    role: ImapFolderRole,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ImapAppendResult | null>;
  /** `uidValidity` must be the value `appendDraft`/`findByMessageId` returned
   * alongside `uid` — a bare UID is only meaningful under the UIDVALIDITY it
   * was issued under. */
  moveToSent(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Reads back the RFC 5322 source of the draft at `uid` in the configured
   * Drafts folder, so a caller can submit via SMTP the same message that
   * will later be moved to Sent — not a re-derived reconstruction built
   * from data it no longer has on hand. The bytes `imapflow` returns are
   * decoded as UTF-8 text (see the implementation), so this is exact only
   * for what `buildMime` produces (plain ASCII/UTF-8 headers, base64 body);
   * a source containing non-UTF-8 content would come back lossily
   * re-encoded, not byte-identical. Same UIDVALIDITY-refusal doctrine as
   * `moveToSent`: `uid` is only meaningful under the UIDVALIDITY it was
   * issued under. */
  fetchDraftSource(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ): Promise<string>;
  /** `uidNext` (the UID the mailbox will assign to the next arriving
   * message) lets a caller anchor a first-ever sync at "whatever's next"
   * when there is nothing recent enough to backfill from — see
   * `findFirstUidSince`. */
  status(
    signal?: AbortSignal,
  ): Promise<{ uidValidity: number; uidNext: number }>;
  fetchRange(
    range: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ImapFetchedMessage[]>;
  /** Lowest UID among messages whose IMAP INTERNALDATE (server arrival time,
   * not the sender-controlled `Date:` header) is on or after `since` — IMAP
   * `SEARCH SINCE` is date-granularity only (RFC 3501 §6.4.4 explicitly
   * disregards time and time zone), so this bounds a first sync to roughly
   * "today" rather than to the second, but that is already the difference
   * between walking a mailbox's entire history and walking essentially
   * nothing. Returns `null` when no message matches (nothing that recent, or
   * an empty mailbox) — the caller is expected to fall back to `uidNext` in
   * that case, not to `1`. */
  findFirstUidSince(since: Date, signal?: AbortSignal): Promise<number | null>;
}

const DRAFTS_SPECIAL_USE = "\\Drafts";
const SENT_SPECIAL_USE = "\\Sent";
const DRAFTS_CONVENTIONAL_NAMES = ["Drafts", "Brouillons"];
const SENT_CONVENTIONAL_NAMES = ["Sent", "Sent Items", "Envoyés", "Envoyes"];
/** Messages are paginated at this size when streamed out of `fetchRange`, so
 * a single huge range never sits fully in memory before the caller sees it. */
const FETCH_PAGE_SIZE = 5;
/** Hard ceiling for one third-party RFC 5322 source. It bounds both the
 * imapflow buffer and mailparser's allocation; the downstream useful body is
 * capped at 1 MiB, so retaining arbitrary attachment payloads is unnecessary. */
const MAX_INBOUND_SOURCE_BYTES = 10 * 1024 * 1024;
/** Every connection this client opens uses these explicit bounds instead of
 * `imapflow`'s own defaults — a wrapper that opens one connection per call
 * (see `withConnection`) must not let a stalled TCP handshake or a
 * half-answered greeting hang indefinitely. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_GREETING_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

function findBySpecialUse(
  folders: ImapFolderDescriptor[],
  specialUse: string,
): string | null {
  return (
    folders.find((folder) => folder.specialUse === specialUse)?.path ?? null
  );
}

function findByConventionalName(
  folders: ImapFolderDescriptor[],
  names: string[],
): string | null {
  const lowered = names.map((name) => name.toLowerCase());
  return (
    folders.find((folder) => lowered.includes(folder.path.toLowerCase()))
      ?.path ?? null
  );
}

/**
 * Resolves the Drafts/Sent folder paths from an already-fetched folder
 * listing. Pure and synchronous by design — it is the boundary that makes
 * folder discovery testable without a server. Order of resolution per role:
 * the server-advertised special-use flag first (`\Drafts`/`\Sent`), then a
 * conventional name match (case-insensitive), otherwise an explicit error —
 * this never guesses.
 */
export function resolveFolderRoles(
  folders: ImapFolderDescriptor[],
): ImapFolderRoles {
  const drafts =
    findBySpecialUse(folders, DRAFTS_SPECIAL_USE) ??
    findByConventionalName(folders, DRAFTS_CONVENTIONAL_NAMES);
  if (!drafts)
    throw new ImapFolderResolutionError("Unable to resolve the Drafts folder");

  const sent =
    findBySpecialUse(folders, SENT_SPECIAL_USE) ??
    findByConventionalName(folders, SENT_CONVENTIONAL_NAMES);
  if (!sent)
    throw new ImapFolderResolutionError("Unable to resolve the Sent folder");

  return { drafts, sent };
}

function toSecurityOptions(security: "tls" | "starttls"): {
  secure: boolean;
  doSTARTTLS?: boolean;
} {
  // Encryption is never optional here: `tls` connects already encrypted,
  // `starttls` connects plaintext-socket-then-upgrades — there is no third,
  // unencrypted path.
  return security === "tls"
    ? { secure: true }
    : { secure: false, doSTARTTLS: true };
}

/** Joins an `imapflow` envelope address array into a single comma-separated
 * string of bare addresses, or `null` when empty/absent. Keeping every
 * address (not just the first) matters here: a reply where the mailbox is
 * one of several `To:`/`Cc:` recipients must not silently lose the others —
 * this field drives reply matching downstream. */
function formatAddressList(
  addresses: Array<{ address?: string }> | undefined,
): string | null {
  if (!addresses || addresses.length === 0) return null;
  const values = addresses
    .map((address) => address.address)
    .filter((address): address is string => Boolean(address));
  return values.length > 0 ? values.join(", ") : null;
}

/**
 * Thin wrapper around `imapflow`. No `imapflow` type is ever part of a public
 * method signature (see `ImapPort`) — the Task 8 provider (and this module's
 * own tests) can double this class without depending on the library at all.
 * Every public method opens its own short-lived connection and always logs
 * out, so no connection state leaks across calls or across test runs.
 */
export class ImapClient implements ImapPort {
  constructor(
    private readonly transport: MailboxTransport,
    private readonly credentials: MailboxCredentials,
  ) {}

  private createConnection(): ImapFlow {
    return new ImapFlow({
      host: this.transport.imap.host,
      port: this.transport.imap.port,
      ...toSecurityOptions(this.transport.imap.security),
      auth: {
        user: this.credentials.user,
        pass: this.credentials.pass,
      },
      logger: false,
      connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS,
      greetingTimeout: DEFAULT_GREETING_TIMEOUT_MS,
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
    });
  }

  private async withConnection<T>(
    fn: (client: ImapFlow) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const client = this.createConnection();
    const onAbort = () => client.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect();
    } catch (error) {
      // imapflow's connect() can reject — bad auth, no STARTTLS, a failed
      // NAMESPACE call, ... — from beginSession's own catch handler without
      // ever calling close() itself (node_modules/imapflow/lib/imap-flow.js,
      // beginSession). Left alone, that socket stays open until its own
      // ~5 minute socketTimeout elapses. Every connect failure is closed
      // here explicitly so a verification loop (Task 12) or a poller never
      // piles up dangling sockets.
      client.close();
      signal?.removeEventListener("abort", onAbort);
      // Re-classify before any caller ever sees this error, exactly once,
      // right here: every public method on this class opens its own
      // connection through this same `withConnection`, so this is the one
      // choke point where a raw `imapflow` auth failure first enters our
      // code, whichever method (`createDraft`, `sendDraft`'s
      // `fetchDraftSource`, `reconcile`'s `findByMessageId`, ...) triggered
      // it. See `classifyImapAuthFailure` for the full rationale.
      if (classifyImapAuthFailure(error)) {
        throw new ImapAuthenticationError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    try {
      return await fn(client);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await client.logout().catch(() => {
        // Best-effort: the operation above already completed (or failed on
        // its own terms) by the time logout runs.
      });
    }
  }

  /** Lists every mailbox and resolves Drafts/Sent via `resolveFolderRoles`.
   * Used for connection verification (Task 12), not for routine
   * append/move — those trust `transport.folders`, which this discovery is
   * meant to populate in the first place. */
  async resolveFolders(signal?: AbortSignal): Promise<ImapFolderRoles> {
    return this.withConnection(async (client) => {
      const mailboxes = await client.list();
      const folders: ImapFolderDescriptor[] = mailboxes.map((mailbox) => ({
        path: mailbox.path,
        specialUse: mailbox.specialUse,
      }));
      return resolveFolderRoles(folders);
    }, signal);
  }

  /**
   * Appends `mime` to the configured Drafts folder, flagged `\Draft`.
   * Returns `{ uidValidity, uid }` using the server's `APPENDUID` response
   * when `UIDPLUS` is actually available at append time; otherwise falls
   * back to searching the Drafts folder for the `Message-ID` this MIME
   * source already carries. Never assumes `UIDPLUS` up front.
   */
  async appendDraft(
    mime: string,
    signal?: AbortSignal,
  ): Promise<ImapAppendResult> {
    const draftsPath = this.transport.folders.drafts;
    return this.withConnection(async (client) => {
      const result = await client.append(draftsPath, mime, ["\\Draft"]);
      if (!result) {
        throw new Error("IMAP APPEND failed");
      }
      if (result.uidValidity !== undefined && result.uid !== undefined) {
        return { uidValidity: Number(result.uidValidity), uid: result.uid };
      }

      const messageId = extractMessageId(mime);
      if (!messageId) {
        throw new Error(
          "APPEND did not return APPENDUID and the MIME source carries no Message-ID to fall back on",
        );
      }
      const found = await this.searchByMessageId(client, draftsPath, messageId);
      if (!found) {
        throw new Error(
          "APPEND succeeded but the appended draft could not be relocated by Message-ID",
        );
      }
      return found;
    }, signal);
  }

  /** Searches the folder bound to `role` (`transport.folders.drafts` or
   * `.sent` — the same paths `appendDraft`/`moveToSent` write to) for a
   * message carrying `messageId`. Returns the newest match (highest UID),
   * or `null` when none is found — never throws on a plain "not found". */
  async findByMessageId(
    role: ImapFolderRole,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ImapAppendResult | null> {
    const folder = this.transport.folders[role];
    return this.withConnection(
      (client) => this.searchByMessageId(client, folder, messageId),
      signal,
    );
  }

  private async searchByMessageId(
    client: ImapFlow,
    folder: string,
    messageId: string,
  ): Promise<ImapAppendResult | null> {
    // Read-only: this never sets flags or otherwise mutates the mailbox, so
    // it opens with EXAMINE instead of SELECT.
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      // Same rigor as `status()`: a mailbox without a live `uidValidity`
      // once opened is a hard failure, not "treat it as 0" — a 0 would be
      // silently wrong for any real UID it gets paired with.
      if (!client.mailbox || client.mailbox.uidValidity === undefined) {
        throw new Error(`IMAP could not read UIDVALIDITY for "${folder}"`);
      }
      const uidValidity = Number(client.mailbox.uidValidity);

      const uids = await client.search(
        { header: { "message-id": messageId } },
        { uid: true },
      );
      // `imapflow`'s SEARCH returns `false` on failure
      // (node_modules/imapflow/lib/commands/search.js), a distinct case
      // from a successful search with zero hits (`[]`). Collapsing both
      // into "no draft found" is exactly the same defect fixed in
      // `status()` at fix round 1: `findByMessageId` backs `createDraft`'s
      // decision to `APPEND` a new draft, so a transient SEARCH failure
      // misread as "not found" produces a duplicate draft — precisely what
      // the deterministic Message-ID exists to prevent.
      if (uids === false) {
        throw new Error(`IMAP SEARCH by Message-ID failed in "${folder}"`);
      }
      if (uids.length === 0) return null;
      // Not `Math.max(...uids)`: spreading a large array into call arguments
      // blows the engine's call-stack argument limit (~100k, measured) —
      // vanishingly unlikely for one Message-ID's worth of drafts, but
      // `findFirstUidSince` below hit exactly this with a real SEARCH
      // result, and the two shared the pattern.
      const uid = uids.reduce((max, candidate) =>
        candidate > max ? candidate : max,
      );
      return { uidValidity, uid };
    } finally {
      lock.release();
    }
  }

  /**
   * Moves the draft at `uid` (in the configured Drafts folder) into the
   * configured Sent folder. `uidValidity` must be the value returned
   * alongside `uid` when the draft was created/found — if the Drafts folder
   * was recreated in between (a new UIDVALIDITY), `uid` may now name a
   * completely different message, so this refuses to move it rather than
   * guess. Called after a successful SMTP submit — the caller is expected
   * to treat failure here as best-effort (the send itself already
   * succeeded).
   */
  async moveToSent(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const draftsPath = this.transport.folders.drafts;
    const sentPath = this.transport.folders.sent;
    await this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(draftsPath);
      try {
        const currentUidValidity = Number(
          client.mailbox ? client.mailbox.uidValidity : 0n,
        );
        if (currentUidValidity !== uidValidity) {
          throw new Error(
            `Drafts folder UIDVALIDITY changed since the draft was created ` +
              `(expected ${uidValidity}, found ${currentUidValidity}); refusing to move uid ${uid}, ` +
              `which may now reference an unrelated message`,
          );
        }
        // imapflow's MOVE swallows server-side rejections (folder renamed,
        // quota, ACL, ...) and resolves `false` instead of throwing
        // (node_modules/imapflow/lib/commands/move.js). An ignored `false`
        // here would look like a silent success: the draft stays in
        // Drafts while the send pipeline believes it was filed as Sent.
        const clearedDraftFlag = await client.messageFlagsRemove(
          [uid],
          ["\\Draft"],
          { uid: true },
        );
        if (!clearedDraftFlag) {
          throw new Error(
            `Could not clear \\Draft from uid ${uid} before filing it as Sent`,
          );
        }
        try {
          const moved = await client.messageMove([uid], sentPath, {
            uid: true,
          });
          if (!moved) {
            throw new Error(
              `IMAP MOVE of draft uid ${uid} to "${sentPath}" failed`,
            );
          }
        } catch (error) {
          await client
            .messageFlagsAdd([uid], ["\\Draft"], { uid: true })
            .catch(() => false);
          throw error;
        }
      } finally {
        lock.release();
      }
    }, signal);
  }

  /**
   * Reads back the source of the draft at `uid` in the configured Drafts
   * folder, decoded as UTF-8 (see `ImapPort.fetchDraftSource` for what that
   * does and does not guarantee byte-for-byte). Read-only (`EXAMINE`,
   * matching `searchByMessageId`). Refuses on a UIDVALIDITY mismatch
   * exactly like `moveToSent` — a `uid` under a stale UIDVALIDITY may now
   * name a completely different message.
   */
  async fetchDraftSource(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const draftsPath = this.transport.folders.drafts;
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(draftsPath, { readOnly: true });
      try {
        if (!client.mailbox || client.mailbox.uidValidity === undefined) {
          throw new Error(
            `IMAP could not read UIDVALIDITY for "${draftsPath}"`,
          );
        }
        const currentUidValidity = Number(client.mailbox.uidValidity);
        if (currentUidValidity !== uidValidity) {
          throw new Error(
            `Drafts folder UIDVALIDITY changed since the draft was created ` +
              `(expected ${uidValidity}, found ${currentUidValidity}); refusing to read uid ${uid}, ` +
              `which may now reference an unrelated message`,
          );
        }
        // imapflow's fetchOne resolves `false` on a miss (no matching
        // message) rather than throwing — same doctrine as `search()` in
        // `searchByMessageId` and `messageMove()` in `moveToSent`: an
        // ignored `false` here would read as an empty draft submitted to
        // SMTP instead of the hard failure it actually is.
        const message = await client.fetchOne(
          String(uid),
          { source: true },
          { uid: true },
        );
        if (!message || !message.source) {
          throw new Error(
            `IMAP FETCH of draft uid ${uid} in "${draftsPath}" failed`,
          );
        }
        return message.source.toString("utf-8");
      } finally {
        lock.release();
      }
    }, signal);
  }

  /** Reads the current `UIDVALIDITY`/`UIDNEXT` of the configured inbox
   * without opening it. Callers compare `uidValidity` against a stored
   * cursor to decide whether history must be rebaselined, and use
   * `uidNext` as the "nothing to backfill" anchor for a first sync (see
   * `findFirstUidSince`). */
  async status(
    signal?: AbortSignal,
  ): Promise<{ uidValidity: number; uidNext: number }> {
    return this.withConnection(async (client) => {
      const inboxPath = this.transport.folders.inbox;
      const rawStatus = await client.status(inboxPath, {
        uidValidity: true,
        uidNext: true,
      });
      // imapflow's shipped .d.ts declares this call as always returning a
      // `StatusObject`, but the implementation
      // (node_modules/imapflow/lib/commands/status.js) returns `false` on
      // any non-NotFound failure. Treating that (or an object with no
      // `uidValidity`/`uidNext`) as "0" would read to a caller as "brand new
      // mailbox" and trigger a full history rebaseline (or an unbounded
      // backfill anchor) on what may be a transient error — so all of these
      // are treated as a hard failure instead.
      const status = rawStatus as
        { uidValidity?: bigint; uidNext?: number } | false;
      if (
        !status ||
        status.uidValidity === undefined ||
        status.uidNext === undefined
      ) {
        throw new Error(`IMAP STATUS failed for "${inboxPath}"`);
      }
      return {
        uidValidity: Number(status.uidValidity),
        uidNext: status.uidNext,
      };
    }, signal);
  }

  /** See `ImapPort.findFirstUidSince`. Read-only (`EXAMINE`, matching
   * `searchByMessageId`/`fetchDraftSource`). */
  async findFirstUidSince(
    since: Date,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const inboxPath = this.transport.folders.inbox;
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(inboxPath, { readOnly: true });
      try {
        const uids = await client.search({ since }, { uid: true });
        // Same doctrine as `searchByMessageId`: imapflow's SEARCH returns
        // `false` on failure, a distinct case from a successful search with
        // zero hits (`[]`) — collapsing the two would read a transient
        // failure as "nothing since this date", which a caller uses to
        // decide how much history to skip.
        if (uids === false) {
          throw new Error(`IMAP SEARCH SINCE failed for "${inboxPath}"`);
        }
        if (uids.length === 0) return null;
        // Not `Math.min(...uids)`: spreading `uids` into call arguments
        // throws `RangeError: Maximum call stack size exceeded` past
        // roughly 100k elements (measured) — a real SEARCH SINCE result on
        // a high-volume mailbox with a months-old sync gap. That crash
        // would abort `fetchSince` before the cursor advances, exactly the
        // failure mode this method exists to prevent, just moved one call
        // deeper.
        return uids.reduce((min, candidate) =>
          candidate < min ? candidate : min,
        );
      } finally {
        lock.release();
      }
    }, signal);
  }

  /**
   * Streams the configured inbox's messages in `range` (IMAP UID
   * sequence-set syntax, e.g. `"42:*"`) page by page — never accumulating
   * the whole range in memory — so a caller that throws partway through a
   * large range still keeps whatever pages it already ingested. The
   * connection is opened for the lifetime of the generator and always
   * released, including when the caller stops iterating early or the fetch
   * itself throws.
   *
   * `body` is the *full* raw RFC 5322 source (headers included) as the exact
   * `Buffer` `imapflow` returned, not an extracted/decoded body and not a
   * string. Two failure modes this specifically avoids: a naive
   * header-strip-then-maybe-base64-decode (an earlier version of this
   * method) throws away the top-level `Content-Type` boundary a real MIME
   * parser needs to make sense of inbound mail (`multipart/alternative`,
   * `quoted-printable`, HTML-only replies); and — separately, and easy to
   * miss because 7-bit-safe encodings (`quoted-printable`, `base64`) hide it
   * — calling `.toString("utf-8")` on the raw bytes (also an earlier version
   * of this method) *transcodes* any genuinely 8-bit, non-UTF-8 body
   * (`Content-Transfer-Encoding: 8bit`/`binary` with a `charset` like
   * `iso-8859-1`, common in older or non-web mail clients) into replacement
   * characters *before* a MIME parser ever sees it — by then the original
   * bytes are gone, no charset-aware decoding downstream can recover them.
   * `References` also isn't part of IMAP's ENVELOPE structure at all, so a
   * caller that needs it has to read headers itself regardless. The inbound
   * source (Task 11) owns all of this interpretation via `mailparser`, once,
   * over this untouched `Buffer`; `fetchDraftSource` above returns a string
   * instead only because it exists to feed `buildMime`'s own
   * plain-ASCII/UTF-8 output back into SMTP, not to read third-party mail.
   */
  async *fetchRange(
    range: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ImapFetchedMessage[]> {
    throwIfAborted(signal);
    const client = this.createConnection();
    const onAbort = () => client.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      signal?.removeEventListener("abort", onAbort);
      throw error;
    }
    try {
      // Read-only: fetching messages never mutates the mailbox.
      const lock = await client.getMailboxLock(this.transport.folders.inbox, {
        readOnly: true,
      });
      try {
        let page: ImapFetchedMessage[] = [];
        // Each row below is yielded from inside imapflow's own FETCH
        // response loop (node_modules/imapflow/lib/imap-flow.js `fetch()`):
        // the command handler pushes rows into a queue and this generator
        // drains them one at a time via `for await`. That is safe here only
        // because this method owns a dedicated connection for its whole
        // lifetime — but it means however long the *consumer* holds a page
        // before requesting the next one counts against this connection's
        // `socketTimeout`, not just server-side latency.
        //
        // Also: per RFC 3501 §6.4.8, a range ending in `*` always resolves
        // `*` to the mailbox's highest UID, so `UID FETCH n:*` can include
        // that highest-UID message even when it is below `n` (a mailbox
        // that appears to have "gone backward"). A caller resuming from a
        // cursor can therefore see an already-processed UID again — dedupe
        // on `providerMessageId`, not on "was this UID new to me".
        for await (const message of client.fetch(
          range,
          {
            envelope: true,
            source: { start: 0, maxLength: MAX_INBOUND_SOURCE_BYTES },
            internalDate: true,
          },
          { uid: true },
        )) {
          page.push({
            uid: message.uid,
            envelope: {
              messageId: message.envelope?.messageId ?? null,
              subject: message.envelope?.subject ?? null,
              from: formatAddressList(message.envelope?.from),
              to: formatAddressList(message.envelope?.to),
              date: message.envelope?.date ?? null,
            },
            // imapflow's own .d.ts types this as `Date | string`, unlike the
            // plain `Date` it declares for `envelope.date` — `new Date(...)`
            // normalizes either shape (and is a no-op for an already-`Date`
            // input) rather than trusting the field is always pre-parsed.
            internalDate: message.internalDate
              ? new Date(message.internalDate)
              : null,
            body: message.source ?? Buffer.alloc(0),
          });
          if (page.length >= FETCH_PAGE_SIZE) {
            yield page;
            page = [];
          }
        }
        if (page.length > 0) yield page;
      } finally {
        lock.release();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await client.logout().catch(() => {});
    }
  }
}
