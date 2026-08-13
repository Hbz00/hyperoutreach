import { createHash } from "node:crypto";

import { htmlToText } from "html-to-text";
import {
  simpleParser,
  type AddressObject,
  type EmailAddress,
  type ParsedMail,
} from "mailparser";

import type { ImapFetchedMessage, ImapPort } from "@/lib/smtp-imap/imap-client";
import type {
  InboundFetchResult,
  InboundMailSource,
} from "@/modules/mailboxes/inbound-source";
import { normalizeEmail } from "@/modules/prospects/normalization";

// Mirrors `inboundSchema`'s own bounds (`src/modules/replies/inbound-service.ts`)
// exactly — every clamp below exists so a value that would otherwise fail
// that schema (`INVALID_INPUT`) never reaches it. `INVALID_INPUT` aborts the
// whole reconciliation round *before* the cursor advances (see
// `SmtpImapInboundSource.fetchSince`'s dedup comment for the general shape of
// this failure mode) — every field below is sender-controlled, so a single
// oversized header from a third party would otherwise poison the mailbox
// permanently, not just degrade that one message.
const PROVIDER_MESSAGE_ID_MAX_LENGTH = 1_000;
const MESSAGE_ID_MAX_LENGTH = 2_000;
const REFERENCES_MAX_COUNT = 100;
const SUBJECT_MAX_LENGTH = 10_000;
const BODY_MAX_LENGTH = 1_000_000;
const ADDRESS_MAX_LENGTH = 500;

/**
 * `inboundSchema.sender`/`.recipient` are both `.trim().min(1)`, always
 * required — `""` is the same poison-pill class as every other field in this
 * file: `INVALID_INPUT` aborts the round before the cursor advances,
 * freezing the mailbox on that one message forever. Terminal placeholders
 * for when nothing usable was found at all. An `@invalid` address is RFC
 * 2606's reserved TLD for exactly this — a syntactically valid,
 * unambiguously-fake placeholder, never a real domain a reply could actually
 * come from or a mailbox actually be — so it passes `normalizeEmail`
 * downstream without risking a collision with a genuine address. The record
 * still lands (as `unmatched`, same as any reply from an address
 * `findMatchedMessage` doesn't recognize), so it stays visible for an
 * operator instead of vanishing silently. Distinct placeholders per role so
 * an operator scanning `inbound_records` can tell which side was unknown.
 */
const UNKNOWN_SENDER_ADDRESS = "unknown-sender@unparseable.invalid";
const UNKNOWN_RECIPIENT_ADDRESS = "unknown-recipient@unparseable.invalid";

type ParsedCursor = { uidValidity: number; lastUid: number };

/** Strictly `<digits>:<digits>`, fully anchored. Two traps a looser parse
 * (splitting on the first `:` and calling `Number()` on each half) falls
 * into: `Number("")` is `0`, not `NaN`, so a truncated cursor like `"7:"`
 * would silently parse as `{ uidValidity: 7, lastUid: 0 }` — a corrupted
 * stored value read as "resume from the very start", not flagged as
 * anything unusual; and `Number()` also accepts floats, whitespace, and
 * negative numbers, none of which are valid UIDs. */
const CURSOR_PATTERN = /^(\d+):(\d+)$/;

function parseCursor(cursor: string): ParsedCursor | null {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) return null;
  const uidValidity = Number(match[1]);
  const lastUid = Number(match[2]);
  if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(lastUid))
    return null;
  return { uidValidity, lastUid };
}

/**
 * `envelope.from`/`.to` (imap-client.ts's `formatAddressList`) join every
 * address with `", "` instead of keeping only the first — deliberately, so a
 * Cc'd mailbox or a multi-recipient `To:` never silently loses an address at
 * that layer. `sender` in particular cannot inherit that string as-is: the
 * inbound pipeline's own `normalizeEmail` throws on anything with more than
 * one `@`, and an `INVALID_INPUT` there aborts the whole reconciliation round
 * *before* the cursor advances — the very next poll would refetch and choke
 * on the same message again, forever. Always reduce to a single address here.
 */
function firstAddress(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first ? first : undefined;
}

function flattenAddresses(
  value: AddressObject | AddressObject[] | undefined,
): EmailAddress[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((entry) => entry.value ?? []);
}

/**
 * Removes NUL (`U+0000`) bytes, which PostgreSQL refuses outright — and which
 * every other clamp in this file misses, because this is a question of
 * *encoding*, not of width or emptiness. A NUL survives `trim()` (it is not
 * whitespace) and survives `slice()`, and `inboundSchema` has no opinion on
 * it, so it reaches the database intact. There it is rejected twice over:
 * `22P05 unsupported Unicode escape sequence` on the `jsonb`
 * `inbound_records.metadata` insert, and `22021 invalid byte sequence for
 * encoding "UTF8": 0x00` on `text` columns (`replies.body`/`.subject`/
 * `.sender`). Both surface as `DATABASE_ERROR`, which
 * `inbound-reconciliation.ts` turns into a thrown round — the cursor never
 * advances, the mailbox is frozen forever on that one message and the send
 * gate closes with it. That is C1 exactly, through a door that checking
 * lengths cannot find. Real mail carries NULs: a truncated attachment, a
 * mis-declared charset, a broken client writing a C string verbatim.
 *
 * Applied to **every** text value this file projects, not just the obvious
 * `body`/`subject` — the lesson of the previous round, where fixing only the
 * field that had been demonstrated left two more of the same shape open.
 */
function stripNul(value: string): string {
  return value.replaceAll("\u0000", "");
}

/** Caps both the *count* (`inboundSchema`'s `references: .max(100)`) and the
 * length of each entry (`.max(2_000)`) — a years-long thread accumulates one
 * `Message-ID` per hop, and any single one of them is as sender-controlled
 * (hence as unbounded) as the count itself. */
function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .slice(0, REFERENCES_MAX_COUNT)
    .map((ref) => stripNul(ref).slice(0, MESSAGE_ID_MAX_LENGTH));
}

async function parseDeliveryStatusReport(parsed: ParsedMail | null): Promise<{
  bounceKind: "hard" | "soft";
  bouncedRecipient: string;
  inReplyTo?: string;
  outreachId?: string;
} | null> {
  if (!parsed) return null;
  const contentType = parsed.headers.get("content-type");
  const isDeliveryReport =
    typeof contentType === "object" &&
    contentType !== null &&
    "value" in contentType &&
    String(contentType.value).toLowerCase() === "multipart/report" &&
    "params" in contentType &&
    String(
      (contentType.params as Record<string, unknown>)["report-type"] ?? "",
    ).toLowerCase() === "delivery-status";
  if (!isDeliveryReport) return null;

  const report = parsed.text ?? "";
  const recipientMatch =
    /^Final-Recipient:\s*(?:[^;\r\n]+;)?\s*([^\s\r\n]+)\s*$/im.exec(report);
  const action = /^Action:\s*([^\s\r\n]+)\s*$/im
    .exec(report)?.[1]
    ?.toLowerCase();
  const status = /^Status:\s*([245]\.[0-9]{1,3}\.[0-9]{1,3})\s*$/im.exec(
    report,
  )?.[1];
  const recipient = recipientMatch?.[1];
  if (!recipient || !status || (action !== "failed" && action !== "delayed"))
    return null;
  const normalized = normalizableAddress(recipient, UNKNOWN_RECIPIENT_ADDRESS);
  if (normalized.rejected) return null;

  const originalAttachment = parsed.attachments.find((attachment) =>
    ["message/rfc822", "message/global"].includes(
      attachment.contentType.toLowerCase(),
    ),
  );
  const original = originalAttachment
    ? await simpleParser(originalAttachment.content).catch(() => null)
    : null;
  const rawOutreachId = original?.headers.get("x-outreach-id");
  const outreachId =
    typeof rawOutreachId === "string"
      ? clampNonEmpty(rawOutreachId, 200)
      : undefined;
  return {
    bounceKind:
      status.startsWith("5.") && action === "failed" ? "hard" : "soft",
    bouncedRecipient: normalized.address,
    inReplyTo: clampNonEmpty(original?.messageId, MESSAGE_ID_MAX_LENGTH),
    outreachId,
  };
}

/** `inboundSchema` requires `.trim().min(1).max(N)` on both `internetMessageId`
 * and `inReplyTo` when present — `undefined` is accepted, `""` is not, and
 * neither is a value over length. mailparser can hand back an empty string
 * for a header a broken client sent blank, which `??` alone does not catch;
 * a header a spammer or a broken client sent absurdly long is the same
 * poison-pill class as an uncapped `references`. */
function clampNonEmpty(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  // `stripNul` first, then `trim`, then `slice`: a value made only of NULs
  // has to end up `undefined` (so the caller's fallback fires) rather than a
  // non-empty string that `.min(1)` accepts and the database then refuses,
  // and the length cap has to be measured on what is actually stored.
  const trimmed = stripNul(value).trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

/**
 * The one downstream check that does **not** live in `inboundSchema`, and so
 * is not covered by any of the clamps above: `ingestInboundMessage`
 * (`inbound-service.ts`) runs `normalizeEmail` on `sender` *after* zod has
 * accepted the payload, and `normalizeEmail`
 * (`@/modules/prospects/normalization`) is far stricter than
 * `.trim().min(1).max(500)` — it rejects a single-label domain
 * (`root@localhost`), any accented or non-ASCII local part, a local part
 * over 64 characters, and anything with more than one `@`. It *throws*, and
 * `ingestInboundMessage` turns that into `INVALID_INPUT` **without touching
 * the database**, which `inbound-reconciliation.ts` turns into a thrown
 * round — so the cursor never advances and the very next poll refetches the
 * same message and dies identically, forever. Exactly the poison-pill class
 * every clamp in this file exists to prevent, just one layer further down
 * than `inboundSchema`.
 *
 * A system message is enough to trigger it: `From: <root@localhost>` (a
 * Zimbra quota warning, a cron mail, a `MAILER-DAEMON` notice) is ordinary
 * mail in a real inbox. So the address that is actually going to be sent
 * downstream is validated here, against the very function that would
 * otherwise reject it, and replaced by the terminal placeholder when it
 * fails. The raw value is not discarded — `projectMessage` records it in
 * `metadata` so an operator can still see who the record came from.
 */
function normalizableAddress(
  candidate: string | undefined,
  fallback: string,
): { address: string; rejected?: string } {
  if (!candidate) return { address: fallback };
  try {
    normalizeEmail(candidate);
    return { address: candidate };
  } catch {
    return { address: fallback, rejected: candidate };
  }
}

/** `inboundSchema.receivedAt` is `z.coerce.date()`, which fails on an
 * `Invalid Date` the same way `.min(1)` fails on `""` — same poison-pill
 * class, different shape. `ImapFetchedMessage.envelope.date`/`internalDate`
 * are typed `Date | null`, but that is `imapflow`'s own `.d.ts` promise, not
 * a runtime guarantee this file has independently verified — `internalDate`
 * itself is typed `Date | string` one file over (imap-client.ts), a
 * precedent for the two disagreeing. Accepts `unknown` deliberately, not
 * `Date | null | undefined`, so a raw unparsed string sneaking through is
 * caught here instead of reaching `z.coerce.date()` un-vetted. */
function validDate(value: unknown): Date | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value
    : undefined;
}

/** Strictly-before, and only when the arrival time is actually known: an
 * absent or unparseable `INTERNALDATE` answers `false` (keep the message).
 * Same `validDate` vetting as `receivedAt`, for the same reason — the value
 * comes from `imapflow`, whose `.d.ts` and runtime already disagree
 * elsewhere. */
function arrivedBefore(value: unknown, floor: Date): boolean {
  const arrived = validDate(value);
  return arrived !== undefined && arrived.getTime() < floor.getTime();
}

/**
 * HTML→text fallback for a reply that carries no `text/plain` alternative
 * (e.g. Outlook's classic `multipart/related; type="text/html"` with an
 * inline signature image — mailparser leaves `parsed.text` unset there since
 * the html part is not the message's root node; see `html-to-text`'s own
 * `htmlToText`, which is also what mailparser calls internally
 * (`mail-parser.js`) for the cases it *does* convert on its own, so a caller
 * needing to convert a non-root html part gets the exact same conversion
 * quality by calling it directly here — no hand-rolled tag-stripping, which
 * both misses/mis-decodes HTML entities and cannot be that library's equal).
 */
function htmlFallbackText(html: string): string {
  try {
    return htmlToText(html).trim();
  } catch {
    return "";
  }
}

/**
 * Inbound source backed by IMAP UID polling. The cursor is
 * `` `${uidValidity}:${lastProcessedUid}` ``; a stored cursor whose
 * `UIDVALIDITY` no longer matches the mailbox's current one — or that fails
 * to parse at all (corrupted storage) — is IMAP's own analogue of Graph's
 * `410`/`syncStateNotFound`: history restarts and the round reports
 * `rebaselined: true`, honestly, rather than silently walking from scratch
 * under a `synced` label.
 */
export class SmtpImapInboundSource implements InboundMailSource {
  readonly kind = "smtp_imap" as const;

  constructor(
    private readonly imap: ImapPort,
    private readonly mailboxId: string,
    /**
     * The mailbox's own address, used to pick the right entry out of a
     * multi-recipient `To:`/`Cc:` when projecting `recipient` — a reply
     * where this mailbox was only Cc'd, or one of several `To:` addresses,
     * should not record some other recipient's address instead. Optional
     * (and unused by the fallback path) because the projection still works,
     * just less precisely, without it.
     */
    private readonly mailboxEmail?: string,
    /**
     * Bounds a fresh (no-cursor or rebaselined) walk to messages no older
     * than roughly this date, mirroring `microsoft-graph-inbound-source.ts`'s
     * `mailbox.since` — without it, a mailbox connected with years of
     * history would walk *all* of it on the very first round, over one
     * long-lived IMAP connection (`fetchRange` documents the socketTimeout
     * risk this creates for a slow classifier), reporting the round `failed`
     * and leaving the send gate closed for as long as onboarding takes.
     * Optional and unbounded (starts at uid 1) when omitted, so existing
     * callers/tests that never had a notion of "since" keep working exactly
     * as before.
     */
    private readonly since?: Date,
  ) {}

  async fetchSince(
    cursor: string | null,
    ingestPage: (messages: unknown[]) => Promise<number>,
  ): Promise<InboundFetchResult> {
    const status = await this.imap.status();
    const parsedCursor = cursor === null ? null : parseCursor(cursor);
    // A non-null cursor that fails to parse is corrupted storage, not "no
    // cursor" — both force a fresh walk, but only the corrupted case is a
    // rebaseline: reporting it as a plain `synced` round would tell an
    // operator watching `*.inbound_rebaselined` events that nothing unusual
    // happened.
    const cursorCorrupted = cursor !== null && parsedCursor === null;
    const rebaselined =
      cursorCorrupted ||
      (parsedCursor !== null &&
        parsedCursor.uidValidity !== status.uidValidity);
    const freshWalk = parsedCursor === null || rebaselined;
    const startUid = freshWalk
      ? await this.resolveBackfillStartUid(status)
      : parsedCursor.lastUid + 1;
    const range = `${startUid}:*`;

    /**
     * The client-side half of the `since` bound, and only on a fresh walk.
     *
     * `findFirstUidSince` asks the server for `SEARCH SINCE`, which RFC 3501
     * §6.4.4 defines as **date granularity** — it disregards time and time
     * zone entirely. So an anchor of "now minus five minutes" resolves, on
     * the server, to "since midnight this morning": the first walk of a
     * freshly connected mailbox starts at the day's first UID and sweeps up
     * every personal message the operator received today. Each one is a real
     * private email, handed to the reply classifier (an OpenAI call) and
     * persisted in clear text in `inbound_records.metadata`. The server-side
     * SEARCH stays as the coarse filter — it is what keeps the walk from
     * touching years of history — and this is the fine one.
     *
     * Never on a resumed walk. There, `startUid = lastUid + 1` already means
     * "everything this mailbox has not seen", and a message's INTERNALDATE
     * can legitimately predate the anchor while still being new to us: a
     * server-side filter (Zimbra rules, Sieve) or an IMAP `COPY`/`APPEND`
     * moving mail into INBOX preserves the original arrival time. Date
     * filtering a resumed walk would silently drop those — genuine replies,
     * including unsubscribes — which is a strictly worse failure than the
     * one this exists to fix.
     */
    const dateFloor = freshWalk ? this.since : undefined;

    // Always `startUid - 1`: correct whether this round resumes normally
    // (`startUid = lastUid + 1`, so this is just `lastUid`), starts
    // completely fresh (`startUid = 1`, so this is `0`), or starts from a
    // `since`-bounded anchor (`startUid` > 1 with nothing "processed" below
    // it yet) — an empty round always advances the cursor to exactly
    // "everything below `startUid` counts as caught up", never further.
    let highestUid = startUid - 1;

    for await (const page of this.imap.fetchRange(range)) {
      // Per RFC 3501 §6.4.8, a range ending in `*` always resolves to the
      // mailbox's highest UID, even when that UID is below the range's
      // start — so any fetch (not just a resumed one: the same trap applies
      // to a `since`-bounded fresh start) can still see a message below
      // `startUid` that has either already been processed or falls outside
      // the intended backfill window. Filtering it out here *is*
      // deduplicating on identity without paying for a round-trip through
      // `ingestPage` to discover it was already seen or unwanted.
      const fresh = page.filter((message) => message.uid >= startUid);
      // A message with no usable INTERNALDATE is *kept*: "the server did not
      // tell us when this arrived" is not evidence that it is old, and
      // dropping a reply on that basis is the expensive mistake.
      const eligible = dateFloor
        ? fresh.filter(
            (message) => !arrivedBefore(message.internalDate, dateFloor),
          )
        : fresh;
      const projected = [];
      for (const message of eligible) {
        projected.push(await this.projectMessage(status.uidValidity, message));
      }
      // Ingest before requesting the next page: a page that fails must not
      // discard the pages already persisted (mirrors the Graph source).
      await ingestPage(projected);
      // Deliberately over `fresh`, not `eligible`: a message skipped for
      // being older than the anchor must still move the cursor past it, or
      // every later round refetches the same day's mail forever — the same
      // cost this filter exists to avoid, merely paid on repeat.
      for (const message of fresh) {
        if (message.uid > highestUid) highestUid = message.uid;
      }
    }

    return {
      nextCursor: `${status.uidValidity}:${highestUid}`,
      rebaselined,
    };
  }

  /** Where a fresh (no-cursor or rebaselined) walk should start: bounded by
   * `since` when one was supplied, unbounded (`1`) otherwise. `since` maps
   * to the lowest uid whose IMAP INTERNALDATE is on or after it; when
   * nothing matches (nothing that recent — the common case right after
   * connecting a mailbox, since `since` is normally "now minus a few
   * minutes"), this anchors at `uidNext` — "whatever arrives from here
   * on" — rather than falling back to `1`, which would silently reintroduce
   * the full-history walk this exists to avoid. */
  private async resolveBackfillStartUid(status: {
    uidNext: number;
  }): Promise<number> {
    if (!this.since) return 1;
    const firstUid = await this.imap.findFirstUidSince(this.since);
    return firstUid ?? status.uidNext;
  }

  private async projectMessage(
    uidValidity: number,
    message: ImapFetchedMessage,
  ) {
    // `message.body` is the full raw RFC 5322 source as a `Buffer` (see
    // imap-client.ts): headers included and never transcoded, so mailparser
    // can see the top-level `Content-Type` boundary a real reply
    // (multipart/alternative, quoted-printable, HTML, 8-bit/non-UTF-8) needs
    // to be read correctly. Never let a single malformed message abort the
    // whole page — degrade to the envelope fallbacks below instead.
    const parsed = await simpleParser(message.body).catch(() => null);
    const deliveryStatus = await parseDeliveryStatusReport(parsed);

    let bodySource: "text" | "html" | "none" = "none";
    let text = parsed?.text?.trim() ?? "";
    if (text) {
      bodySource = "text";
    } else if (parsed?.html) {
      text = htmlFallbackText(parsed.html);
      if (text) bodySource = "html";
    }
    // Deliberately no further fallback to the raw source: an attachment-only
    // message (or a parse failure) has no readable text for the classifier,
    // and handing it the full MIME source instead — headers, boundaries,
    // base64 attachment data, up to `BODY_MAX_LENGTH` — is worse than an
    // empty body, not a reasonable "better than nothing" degrade.

    const senderAddress =
      parsed?.from?.value[0]?.address ?? firstAddress(message.envelope.from);

    const toAddresses = flattenAddresses(parsed?.to);
    const ccAddresses = flattenAddresses(parsed?.cc);
    const mailboxEmail = this.mailboxEmail;
    const ownedRecipient = mailboxEmail
      ? [...toAddresses, ...ccAddresses].find(
          (candidate) =>
            candidate.address?.toLowerCase() === mailboxEmail.toLowerCase(),
        )
      : undefined;
    // `clampNonEmpty`, not `??`, on every mailparser-derived candidate: a
    // `To:`/`Cc:` entry with a display name but no address (e.g. a
    // malformed group, or a name-only entry some clients produce) parses to
    // `address: ""` — not `null`/`undefined` — which `??` alone treats as
    // "found" and stops there, same trap as `sender` below.
    // `firstAddress(message.envelope.to)` is already `""`-safe on its own
    // (imap-client.ts's `formatAddressList` returns `null`, never `""`).
    const recipientAddress =
      clampNonEmpty(ownedRecipient?.address, ADDRESS_MAX_LENGTH) ??
      clampNonEmpty(toAddresses[0]?.address, ADDRESS_MAX_LENGTH) ??
      firstAddress(message.envelope.to) ??
      clampNonEmpty(mailboxEmail, ADDRESS_MAX_LENGTH);

    const internetMessageId =
      clampNonEmpty(parsed?.messageId, MESSAGE_ID_MAX_LENGTH) ??
      clampNonEmpty(
        message.envelope.messageId ?? undefined,
        MESSAGE_ID_MAX_LENGTH,
      );
    const subject = stripNul(
      parsed?.subject ?? message.envelope.subject ?? "",
    ).slice(0, SUBJECT_MAX_LENGTH);
    // IMAP INTERNALDATE (the server's own arrival timestamp) beats both the
    // ENVELOPE date and the parsed `Date:` header: both of those come from
    // the sender-controlled `Date:` header, which a broken client or a
    // deliberately backdated/postdated message can set to anything. This
    // value flows into `enrollments.stoppedAt` downstream, so a spoofed one
    // has a real operational effect, not just a cosmetic one. Every
    // candidate goes through `validDate`: an unparseable `Date:` header can
    // leave `envelope.date` holding the raw unparsed string instead of
    // `null` (`imapflow`'s own `.d.ts` promise of `Date`, not independently
    // verified — see `validDate`'s doc comment), which `??` alone would
    // hand straight to `z.coerce.date()` un-vetted.
    const receivedAt =
      validDate(message.internalDate) ??
      validDate(message.envelope.date) ??
      validDate(parsed?.date) ??
      new Date();

    // Two identities, matching what Graph's own inbound source already
    // relies on (`inbound-service.ts`'s `onConflictDoNothing()` + `OR`
    // re-select over *either* unique index — untouched here, already
    // generic): `providerMessageId` is derived from the message's own
    // `Message-ID` header when one exists, so it stays the *same* physical
    // identity across a `UIDVALIDITY` rebaseline (the uid alone would not:
    // after a rebaseline, uid N names a different message, so keying solely
    // on uid would either resurrect old mail as "new" or — worse — swallow
    // a genuine new reply that happens to land on a recycled uid as a
    // false-duplicate, e.g. missing an unsubscribe). `providerNotificationId`
    // is always the uid-scoped form: guaranteed unique per fetch instance
    // within one epoch even when a message has no `Message-ID` at all
    // (`providerMessageId` then falls back to this same value).
    const providerNotificationId = `imap:${uidValidity}:${message.uid}`;
    const providerMessageId = `imap:sha256:${createHash("sha256")
      .update(internetMessageId ?? "")
      .update("\0")
      .update(subject)
      .update("\0")
      .update(senderAddress ?? "")
      .update("\0")
      .update(recipientAddress ?? "")
      .update("\0")
      .update(
        Buffer.isBuffer(message.body)
          ? message.body
          : Buffer.from(String(message.body)),
      )
      .digest("hex")}`.slice(0, PROVIDER_MESSAGE_ID_MAX_LENGTH);

    // `clampNonEmpty`, not `??`: either address can itself be `""` (a
    // `From:`/`To:` with a display name but no address, e.g. `From: Some
    // Name` — real, seen in the wild), which `??` would let straight through
    // to `inboundSchema`'s `.min(1)`. The clamp runs *before*
    // `normalizableAddress` on purpose: what gets validated has to be the
    // exact string that will be sent downstream, truncation included.
    const sender = normalizableAddress(
      clampNonEmpty(senderAddress, ADDRESS_MAX_LENGTH),
      UNKNOWN_SENDER_ADDRESS,
    );
    const recipient = normalizableAddress(
      clampNonEmpty(recipientAddress, ADDRESS_MAX_LENGTH),
      UNKNOWN_RECIPIENT_ADDRESS,
    );

    return {
      mailboxId: this.mailboxId,
      providerMessageId,
      providerNotificationId,
      internetMessageId,
      inReplyTo:
        deliveryStatus?.inReplyTo ??
        clampNonEmpty(parsed?.inReplyTo, MESSAGE_ID_MAX_LENGTH),
      references: normalizeReferences(parsed?.references),
      outreachId: deliveryStatus?.outreachId,
      sender: sender.address,
      recipient: recipient.address,
      subject,
      body: stripNul(text).slice(0, BODY_MAX_LENGTH),
      receivedAt,
      bounceKind: deliveryStatus?.bounceKind,
      bouncedRecipient: deliveryStatus?.bouncedRecipient,
      metadata: {
        provider: "smtp_imap",
        bodySource,
        // Only present when a fallback actually fired: the operator sees an
        // `unknown-*@unparseable.invalid` record and still needs to know
        // what the message really said.
        ...(sender.rejected ? { unparseableSender: sender.rejected } : {}),
        ...(recipient.rejected
          ? { unparseableRecipient: recipient.rejected }
          : {}),
      },
    };
  }
}
