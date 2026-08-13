// Deliberately no `import "server-only"` here, even though this module is
// only ever meant to run behind the operator command route: the package
// throws unconditionally outside a bundler's `react-server` export
// condition (verified empirically — it also breaks `tests/integration/`'s
// plain `vitest` config, which sets no such condition), not just inside a
// client bundle. Same reasoning, same resolution, as `imap-client.ts`
// (whose own header comment covers this in more detail) and
// `microsoft-oauth-service.ts`, which this module's `connectSmtpImapMailbox`
// otherwise mirrors closely. The unit test's `vi.mock("server-only", ...)`
// call is harmless dead weight without a real import to shadow — kept
// verbatim from the brief rather than removed.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import {
  mailboxConnections,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { defaultInboundNaming } from "@/modules/mailboxes/inbound-reconciliation";
import {
  ImapClient,
  ImapAuthenticationError,
  ImapFolderResolutionError,
  type MailboxCredentials,
} from "@/lib/smtp-imap/imap-client";
import { SmtpClient, SmtpRejectionError } from "@/lib/smtp-imap/smtp-client";
import {
  transportConfigSchema,
  writeTransport,
  type MailboxTransport,
} from "@/lib/smtp-imap/transport-config";
import {
  encryptSecret,
  requireTokenEncryptionKeyring,
} from "@/lib/microsoft/token-crypto";
import { normalizeEmail } from "@/modules/prospects/normalization";

/**
 * The two network probes `verifyTransport` orchestrates. Both take the
 * plaintext password directly (never the encrypted-at-rest form) and either
 * resolve or throw — `verifyTransport` itself never inspects *why* one
 * failed, only *which one* did, so any thrown value (a real `imapflow`/
 * `nodemailer` error, or a fabricated one in a test) is equally valid.
 *
 * `ImapVerify` returns the *full* discovered folder triple
 * (`drafts`/`sent`/`inbox`) — the same shape `MailboxTransport.folders`
 * already has — not just the two roles `resolveFolderRoles` resolves, so a
 * successful `verifyTransport` hands back something directly usable to
 * build the transport that gets persisted, with no caller-side merging.
 */
export type ImapVerify = (
  transport: MailboxTransport,
  password: string,
) => Promise<MailboxTransport["folders"]>;
export type SmtpVerify = (
  transport: MailboxTransport,
  password: string,
) => Promise<void>;

export type ConnectionVerifiers = {
  imapVerify: ImapVerify;
  smtpVerify: SmtpVerify;
};

export type VerifyTransportResult =
  | { ok: true; folders: MailboxTransport["folders"] }
  | {
      ok: false;
      code:
        | "IMAP_AUTH_FAILED"
        | "IMAP_CONNECTION_FAILED"
        | "IMAP_FOLDERS_NOT_FOUND"
        | "SMTP_AUTH_FAILED"
        | "SMTP_CONNECTION_FAILED";
    };

/**
 * The core proof requirement this task exists to satisfy: a mailbox is
 * never marked `available` on faith, only after a real round trip against
 * both protocols it will actually be used through. Pure with respect to the
 * network — `imapVerify`/`smtpVerify` are handed in, never constructed here
 * — so this function is testable with zero real (or fake) servers, and the
 * *order* (IMAP, then SMTP, never the reverse) is itself part of the
 * contract under test: IMAP also proves the Drafts/Sent folders can be
 * resolved, which SMTP alone could never confirm, so failing IMAP first
 * means a caller never pays for an SMTP round trip whose result would be
 * discarded anyway.
 *
 * Mostly coarse-grained — any `smtpVerify` rejection becomes
 * `SMTP_AUTH_FAILED`, and any `imapVerify` rejection that isn't specifically
 * recognized falls back to `IMAP_AUTH_FAILED` — but the one IMAP-side
 * distinction that matters in practice *is* drawn: a definite credentials
 * refusal (`ImapAuthenticationError`, thrown by `withConnection` when
 * `client.connect()` itself failed) is not the same operator problem as a
 * connection that authenticated fine but whose Drafts/Sent folders could
 * not be identified (`ImapFolderResolutionError`, thrown by
 * `resolveFolderRoles` *after* a successful connect — e.g. a French Zimbra
 * naming them "Brouillons"/"Envoyés" outside the recognized conventional
 * names). Telling an operator "identifiants refusés" for the latter sends
 * them to re-check a password that was never the problem. Every other
 * `imapVerify` failure (a raw connection error, a timeout, ...) still falls
 * back to `IMAP_AUTH_FAILED` — this function does not attempt to classify
 * those further; `ImapClient`/`SmtpClient` are expected to fail loudly and
 * specifically enough on their own that an operator reading the two-way
 * protocol split already knows which endpoint to look at.
 */
export async function verifyTransport(
  transport: MailboxTransport,
  password: string,
  deps: ConnectionVerifiers,
): Promise<VerifyTransportResult> {
  let folders: MailboxTransport["folders"];
  try {
    folders = await deps.imapVerify(transport, password);
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof ImapFolderResolutionError
          ? "IMAP_FOLDERS_NOT_FOUND"
          : error instanceof ImapAuthenticationError
            ? "IMAP_AUTH_FAILED"
            : "IMAP_CONNECTION_FAILED",
    };
  }
  try {
    await deps.smtpVerify(transport, password);
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof SmtpRejectionError && error.smtpErrorCode === "EAUTH"
          ? "SMTP_AUTH_FAILED"
          : "SMTP_CONNECTION_FAILED",
    };
  }
  return { ok: true, folders };
}

/** Production `ImapVerify`: authenticates and lists mailboxes
 * (`ImapClient.resolveFolders`, already the exact "connect, auth, list,
 * resolve special-use/conventional names" sequence Task 12 needs — nothing
 * new to write at the protocol layer). `inbox` is not discovered — IMAP's
 * INBOX is a fixed, case-insensitive well-known name (RFC 3501 §5.1), never
 * subject to special-use/localized naming the way Drafts/Sent are — so it
 * is carried through unchanged from the transport handed in (which, for a
 * fresh connection attempt, is always the schema default `"INBOX"`). */
async function defaultImapVerify(
  transport: MailboxTransport,
  password: string,
): Promise<MailboxTransport["folders"]> {
  const credentials: MailboxCredentials = {
    user: transport.username,
    pass: password,
  };
  const client = new ImapClient(transport, credentials);
  const roles = await client.resolveFolders();
  return { ...roles, inbox: transport.folders.inbox };
}

/** Production `SmtpVerify`: `SmtpClient.verify` — connect, STARTTLS/TLS,
 * authenticate, disconnect, never a mail transaction. See that method's own
 * doc comment for why it can never submit a message on any path. */
async function defaultSmtpVerify(
  transport: MailboxTransport,
  password: string,
): Promise<void> {
  const credentials: MailboxCredentials = {
    user: transport.username,
    pass: password,
  };
  const client = new SmtpClient(transport, credentials);
  await client.verify();
}

/** What the operator submits to connect (or reconnect) an `smtp_imap`
 * mailbox. Reuses `transportConfigSchema` (minus `folders`, which is
 * discovered, never operator-supplied) rather than redeclaring host/port/
 * security rules a second time — whatever passes this schema is guaranteed
 * to also round-trip through `readTransport` once persisted. */
const connectionInputSchema = transportConfigSchema
  .omit({ folders: true })
  .extend({
    email: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1000),
  });

export type ConnectSmtpImapMailboxDeps = {
  /** Defaults to `process.env` — matches `provider-bootstrap.ts`'s own
   * fallback for the same keyring lookup. Tests pass an explicit,
   * disposable keyring instead (see `requireTokenEncryptionKeyring`'s own
   * doc comment on why `smtp_imap` must not be forced through any
   * Microsoft-specific config to get one). */
  environment?: Record<string, string | undefined>;
  now?: Date;
  /** Both default to the real network-touching implementations above.
   * Tests override them — this is the *only* seam that keeps
   * `connectSmtpImapMailbox` itself free of any real IMAP/SMTP connection,
   * per this task's "no mail server in tests" constraint. */
  imapVerify?: ImapVerify;
  smtpVerify?: SmtpVerify;
};

export type ConnectSmtpImapMailboxResult =
  | { ok: true; mailbox: typeof mailboxConnections.$inferSelect }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "IMAP_AUTH_FAILED"
        | "IMAP_CONNECTION_FAILED"
        | "IMAP_FOLDERS_NOT_FOUND"
        | "SMTP_AUTH_FAILED"
        | "SMTP_CONNECTION_FAILED"
        | "CONFIGURATION_ERROR"
        | "DATABASE_ERROR";
    };

/**
 * Writes (inserts or updates) the mailbox row for an already-verified
 * connection attempt, and its accompanying `stateTransitions` audit row, in
 * one transaction. Split out from `connectSmtpImapMailbox` purely so the
 * caller can choose *how* to reach this — directly, or through
 * `withActionLocks` — without duplicating the transaction body for each
 * path (see the fix-round-1 lock discussion on `connectSmtpImapMailbox`
 * itself for why the choice matters).
 *
 * `lastSyncedAt` is `existing?.lastSyncedAt ?? anchor` — preserved when a
 * row already carries one, matching `microsoft-oauth-service.ts:280-281`'s
 * own `existing?.lastSyncedAt ?? new Date(now.getTime() - 5 * 60_000)`
 * exactly. A mailbox reconnected mid-revocation with a `syncCursor` already
 * in place is governed by that cursor regardless of `lastSyncedAt` (Task
 * 11's inbound source only consults the anchor on a cursor-less first
 * round), so preserving the prior anchor costs nothing there — but a
 * mailbox that was revoked *before* completing its first inbound round has
 * no cursor yet, and resetting the anchor unconditionally would silently
 * drop any reply that arrived during the revocation window, once the first
 * round finally runs. `anchor` (`now - 5 minutes`) is used only when there
 * is nothing to preserve — a genuinely new mailbox's correct first value.
 *
 * `settings` is written via `writeTransport(existing?.settings ?? {},
 * transport)`, not a bare `{ transport }` — preserving whatever unrelated
 * settings keys the row already carried, exactly what `writeTransport`
 * exists to do. `syncCursor` is never set here either way: absent from
 * `values`, so an UPDATE preserves whatever cursor already existed
 * (continuing exactly where sync left off) and an INSERT leaves it `null`
 * (a genuinely new mailbox's correct first state).
 */
async function writeConnectedMailbox(
  db: AppDatabase,
  params: {
    email: string;
    normalizedEmail: string;
    encryptedPassword: string;
    transport: MailboxTransport;
    anchor: Date;
    now: Date;
  },
): Promise<{ ok: true; mailbox: typeof mailboxConnections.$inferSelect }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(mailboxConnections)
      .where(
        and(
          eq(mailboxConnections.provider, "smtp_imap"),
          eq(mailboxConnections.normalizedEmail, params.normalizedEmail),
        ),
      )
      .limit(1);
    const values = {
      provider: "smtp_imap" as const,
      email: params.email,
      normalizedEmail: params.normalizedEmail,
      status: "available" as const,
      encryptedPassword: params.encryptedPassword,
      settings: writeTransport(existing?.settings ?? {}, params.transport),
      lastSyncedAt: existing?.lastSyncedAt ?? params.anchor,
    };
    const [mailbox] = existing
      ? await tx
          .update(mailboxConnections)
          .set(values)
          .where(eq(mailboxConnections.id, existing.id))
          .returning()
      : await tx.insert(mailboxConnections).values(values).returning();
    if (!mailbox) throw new Error("Mailbox persistence failed");
    // Arms the send gate until the first inbound round actually succeeds.
    //
    // `send-service.ts`'s `inboundSyncPending` only fires when a
    // `workflowEvents` row for this mailbox *exists* and is not `succeeded`.
    // The periodic reconciliation task may not run until the next minute, so
    // a freshly connected mailbox would otherwise have no health row and the
    // gate would read "clear" before a single reply had been read. The
    // prospect may already have answered "stop writing to me". Absence of
    // evidence is not evidence of a healthy inbox: the safe reading of
    // "never synced" is "blocked", and the first successful automatic or
    // operator-triggered sync clears it.
    //
    // Only when nothing has ever synced. A non-null `syncCursor` is the
    // durable proof that at least one round completed (the cursor and its
    // `succeeded` event are written in the same transaction by
    // `createInboundCursorWriter`), so a reconnection that repairs a
    // password on a mailbox already in service does not re-block it.
    // `onConflictDoNothing` on the shared health key so a row that already
    // exists — whatever its state — is left exactly as the health wrapper
    // left it.
    if (!existing?.syncCursor) {
      // Same naming the round itself uses (`inbound-source-bootstrap.ts`'s
      // `smtp_imap` entry), from the same function: the event, workflow name
      // and idempotency key must be *the* health record, not a look-alike
      // the send gate happens to match today.
      const naming = defaultInboundNaming("smtp_imap", mailbox.id);
      await tx
        .insert(workflowEvents)
        .values({
          entityType: "mailbox",
          entityId: mailbox.id,
          event: naming.event,
          workflowName: naming.workflowName,
          idempotencyKey: naming.healthKey,
          status: "scheduled",
          scheduledAt: params.now,
        })
        .onConflictDoNothing();
    }
    await tx.insert(stateTransitions).values({
      entityType: "mailbox",
      entityId: mailbox.id,
      fromState: existing?.status ?? null,
      toState: "available",
      reason: existing ? "smtp_imap_reconnected" : "smtp_imap_connected",
      actor: "operator",
    });
    return { ok: true, mailbox } as const;
  });
}

/**
 * The single path by which an `smtp_imap` mailbox becomes `available` — and,
 * because it always *updates* an existing row by `(provider,
 * normalized_email)` rather than blindly inserting, the single path by
 * which a mailbox the auto-revocation guard (Task 10 bis) put into
 * `revoked` can ever come back. Without the update-not-insert behavior, a
 * revoked mailbox would be permanently unrecoverable: the unique index on
 * `(provider, normalized_email)` would refuse a second row for the same
 * address forever, even after the operator supplies working credentials.
 *
 * Writes the row **only after** `verifyTransport` succeeds — a failed
 * attempt never touches the database at all:
 *   - a brand-new address that fails verification never gets a row (no
 *     "half-connected" `pending` stub is created — such a stub would be
 *     picked up by the very next inbound reconcile round and fail loudly
 *     there too, for no operator benefit);
 *   - an *existing* row (e.g. a `revoked` mailbox reconnected with a typo'd
 *     password) is left completely untouched — still `revoked`, exactly as
 *     it was.
 * The failure `code` returned here is the operator-facing "cause" in both
 * cases — surfaced by the command route's redirect notice, the same
 * pattern every other operator command already uses; there is no per-
 * mailbox error column to persist it into (unlike `messages.lastError`,
 * which is per-message).
 *
 * The write for an *existing* row runs inside `withActionLocks(
 * actionLockKey.mailbox(existing.id))` — the same advisory lock
 * `markMailboxAuthenticationFailed`'s callers already hold for the whole
 * duration of a `sendDraft`/`reconcile` attempt (see that function's own
 * doc comment). Without it, a send already in flight when this function
 * runs — bound to the *old* password, mid network call — can still fail
 * auth and revoke the row *after* this function's own unlocked write
 * already flipped it back to `available`: `markMailboxAuthenticationFailed`
 * only guards `WHERE status = 'available'`, which a repair just made true
 * again, so the operator would see "mailbox connected" and then watch it
 * revoke itself moments later with no correlated action to point to.
 * Acquiring the same lock here forces any attempt that is *concurrently*
 * holding it (the most likely real-world overlap: a message stuck
 * `delivery_uncertain` being retried by `recovery-service.ts` at the exact
 * moment an operator submits the repair form) to fully finish — including
 * its own revoke, if it fails — before this write is allowed to proceed, so
 * this write is never clobbered by *that* attempt. It does not, and cannot
 * by itself, retroactively fix a `sendDraft` call whose credentials were
 * already bound to the old password *before* either side ever touched the
 * lock and which only reaches its own lock acquisition — and its own
 * revoke — after this write has already released the lock; closing that
 * residual would require the provider itself to re-read credentials per
 * attempt rather than caching them at construction time, which is out of
 * this task's scope. A brand-new address has no existing row and thus no
 * `mailboxId` anything else could reference yet, so it is written directly,
 * with no lock to acquire.
 */
export async function connectSmtpImapMailbox(
  db: AppDatabase,
  rawInput: unknown,
  deps: ConnectSmtpImapMailboxDeps = {},
): Promise<ConnectSmtpImapMailboxResult> {
  const parsed = connectionInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };

  const { email, password, ...transportFields } = parsed.data;
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch {
    return { ok: false, code: "INVALID_INPUT" };
  }

  // A placeholder, schema-satisfying `folders` triple — never persisted as
  // is. `verifyTransport`'s IMAP leg discovers the real Drafts/Sent paths;
  // this value only exists so `ImapClient`/`SmtpClient` (which both take a
  // fully-formed `MailboxTransport`) have something to construct against.
  // Neither `resolveFolders` (list + resolve by special-use/conventional
  // name) nor `verify` (connect/auth only) ever reads `transport.folders`,
  // so the placeholder is never actually exercised.
  const draftTransport: MailboxTransport = {
    ...transportFields,
    folders: { drafts: "INBOX", sent: "INBOX", inbox: "INBOX" },
  };

  const verification = await verifyTransport(draftTransport, password, {
    imapVerify: deps.imapVerify ?? defaultImapVerify,
    smtpVerify: deps.smtpVerify ?? defaultSmtpVerify,
  });
  if (!verification.ok) return verification;

  const now = deps.now ?? new Date();
  const transport: MailboxTransport = {
    ...draftTransport,
    folders: verification.folders,
  };

  // Kept in its own `try`/`catch`, distinct from the persistence step below:
  // a misconfigured keyring (`TOKEN_ENCRYPTION_KEYS`/
  // `TOKEN_ENCRYPTION_ACTIVE_KEY_ID` missing or malformed) is an operator/
  // deployment configuration problem, not a database failure — folding it
  // into the same `catch` as the transaction below would report
  // `DATABASE_ERROR` for a cause that has nothing to do with the database.
  let encryptedPassword: string;
  try {
    const keyring = requireTokenEncryptionKeyring(
      deps.environment ?? process.env,
    );
    encryptedPassword = encryptSecret(password, keyring);
  } catch {
    return { ok: false, code: "CONFIGURATION_ERROR" };
  }

  try {
    // Unlocked, read-only lookup purely to learn whether a row already
    // exists and, if so, its id — the lock key `withActionLocks` needs.
    // `writeConnectedMailbox` re-reads the row for real (inside the lock,
    // when one is taken) before deciding insert vs. update, so nothing here
    // is trusted for the actual write; this is only for routing.
    const [existingBeforeLock] = await db
      .select({ id: mailboxConnections.id })
      .from(mailboxConnections)
      .where(
        and(
          eq(mailboxConnections.provider, "smtp_imap"),
          eq(mailboxConnections.normalizedEmail, normalizedEmail),
        ),
      )
      .limit(1);

    const writeParams = {
      email,
      normalizedEmail,
      encryptedPassword,
      transport,
      anchor: new Date(now.getTime() - 5 * 60_000),
      now,
    };
    return existingBeforeLock
      ? await withActionLocks(
          db,
          [actionLockKey.mailbox(existingBeforeLock.id)],
          (lockedDb) => writeConnectedMailbox(lockedDb, writeParams),
        )
      : await writeConnectedMailbox(db, writeParams);
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export type DisconnectSmtpImapMailboxResult =
  { ok: true } | { ok: false; code: "NOT_FOUND" };

/**
 * Mirrors `disconnectMicrosoftMailbox` (`microsoft-oauth-service.ts`) for
 * the `smtp_imap` provider, exactly as the design spec requires ("`Disconnect`
 * efface le mot de passe chiffré, le curseur et le transport, exactement
 * comme la déconnexion Microsoft"): clears the encrypted password, the sync
 * cursor, and the discovered `transport` block, then moves the row to
 * `disconnected`. Any *other* key already present under `settings` is left
 * alone -- same "don't clobber unrelated settings" contract
 * `writeTransport`/`writeConnectedMailbox` already follow on the connect
 * side. Reconnecting afterwards is still `connectSmtpImapMailbox` itself,
 * same as reviving a `revoked` row -- there is no separate "resume" path.
 *
 * A row that isn't `smtp_imap` (including a nonexistent id) returns
 * `NOT_FOUND`, exactly like the Microsoft counterpart returns for a
 * non-`microsoft_graph` row. The command route selects the row's provider
 * and dispatches to the matching function before either is ever called, so
 * this check is a defensive backstop, not the primary guard.
 */
export async function disconnectSmtpImapMailbox(
  db: AppDatabase,
  mailboxId: string,
): Promise<DisconnectSmtpImapMailboxResult> {
  return withActionLocks(
    db,
    [actionLockKey.mailbox(mailboxId)],
    async (lockedDb) => {
      const [mailbox] = await lockedDb
        .select()
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, mailboxId))
        .limit(1);
      if (!mailbox || mailbox.provider !== "smtp_imap") {
        return { ok: false, code: "NOT_FOUND" } as const;
      }
      const remainingSettings = Object.fromEntries(
        Object.entries(mailbox.settings ?? {}).filter(
          ([key]) => key !== "transport",
        ),
      );
      await lockedDb.transaction(async (tx) => {
        await tx
          .update(mailboxConnections)
          .set({
            status: "disconnected",
            encryptedPassword: null,
            syncCursor: null,
            settings: remainingSettings,
          })
          .where(eq(mailboxConnections.id, mailbox.id));
        await tx.insert(stateTransitions).values({
          entityType: "mailbox",
          entityId: mailbox.id,
          fromState: mailbox.status,
          toState: "disconnected",
          reason: "smtp_imap_disconnected",
          actor: "operator",
        });
      });
      return { ok: true } as const;
    },
  );
}
