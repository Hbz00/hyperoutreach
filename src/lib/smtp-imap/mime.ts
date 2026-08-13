/** Header/body inputs needed to assemble an outgoing RFC 5322 message. */
export type MimeInput = {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
};

const HEADER_INJECTION_PATTERN = /[\r\n]/;
const NON_ASCII_PATTERN = /[^\x00-\x7f]/;
/** Keeps each RFC 2047 encoded-word's payload well under the 75-octet cap. */
const MAX_ENCODED_WORD_CHUNK_BYTES = 45;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function assertNoHeaderInjection(label: string, value: string): void {
  if (HEADER_INJECTION_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: must not contain CR or LF`);
  }
}

/**
 * Validates a caller-supplied custom header. Mirrors
 * `MicrosoftGraphMailProvider.createDraft`'s guard
 * (microsoft-graph-mail-provider.ts:36-44) exactly: the name must start with
 * `x-` (case-insensitive) *and* neither the name nor the value may contain
 * `\r`/`\n`. The prefix requirement is not cosmetic — without it a caller
 * (or an upstream value that ends up here unsanitized) could name a header
 * `Bcc`, `From`, or `Message-ID` outright and have it emitted verbatim, no
 * CRLF needed. A duplicate `Message-ID` in particular would break the
 * Message-ID lookup that the whole idempotent-draft/no-double-send design
 * relies on.
 */
function assertSafeCustomHeader(name: string, value: string): void {
  if (!name.toLowerCase().startsWith("x-")) {
    throw new Error(
      `Invalid custom mail header "${name}": must start with "X-"`,
    );
  }
  assertNoHeaderInjection(`header name "${name}"`, name);
  assertNoHeaderInjection(`header "${name}"`, value);
}

/**
 * Encodes a header value as one or more RFC 2047 encoded-words when it
 * leaves ASCII, folding into multiple encoded-words joined by folding
 * whitespace (`\r\n `) once the payload would exceed the 75-octet
 * encoded-word limit. Splits on code points (not UTF-16 code units), so
 * surrogate pairs are never torn across a chunk boundary.
 */
function encodeHeaderValue(value: string): string {
  if (!NON_ASCII_PATTERN.test(value)) return value;

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (
      currentBytes + charBytes > MAX_ENCODED_WORD_CHUNK_BYTES &&
      current.length > 0
    ) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);

  return chunks
    .map(
      (chunk) =>
        `=?UTF-8?B?${Buffer.from(chunk, "utf-8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

function wrapBase64(base64: string): string {
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** Formats a `Date` per RFC 5322 §3.3, using the numeric `+0000` zone rather than the obsolete `GMT`. */
function formatRfc5322Date(date: Date): string {
  const weekday = WEEKDAY_NAMES[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = MONTH_NAMES[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${weekday}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} +0000`;
}

/**
 * Assembles the outgoing message: `From`, `To`, `Subject`, `Date`,
 * `Message-ID`, `MIME-Version`, `Content-Type: text/plain; charset=utf-8`,
 * `Content-Transfer-Encoding: base64`, then the caller-supplied custom
 * headers. Throws if the subject, sender, recipient, or `Message-ID`
 * contains `\r` or `\n`, and throws on any custom header that fails
 * `assertSafeCustomHeader` — CRLF injection or a name outside the `X-`
 * namespace, which would otherwise let a header value smuggle in an
 * arbitrary extra header (a hidden `Bcc:`) or collide with a header this
 * function already controls (a spoofed `Message-ID:`).
 */
export function buildMime(input: MimeInput, messageId: string): string {
  assertNoHeaderInjection("sender", input.sender);
  assertNoHeaderInjection("recipient", input.recipient);
  assertNoHeaderInjection("subject", input.subject);
  assertNoHeaderInjection("Message-ID", messageId);

  for (const [name, value] of Object.entries(input.headers)) {
    assertSafeCustomHeader(name, value);
  }

  const headerLines = [
    `From: ${input.sender}`,
    `To: ${input.recipient}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${formatRfc5322Date(new Date())}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ...Object.entries(input.headers).map(
      ([name, value]) => `${name}: ${value}`,
    ),
  ];

  const encodedBody = wrapBase64(
    Buffer.from(input.body, "utf-8").toString("base64"),
  );

  return `${headerLines.join("\r\n")}\r\n\r\n${encodedBody}`;
}

/** Isolates the header block of a raw MIME source — everything before the
 * first blank line — shared by every `extract*` helper below so a
 * header-looking line quoted inside the body (a forwarded or replied-to
 * message, for instance) can never be mistaken for a real header. */
function headerBlockOf(mime: string): string {
  const separatorIndex = mime.search(/\r?\n\r?\n/);
  return separatorIndex === -1 ? mime : mime.slice(0, separatorIndex);
}

/**
 * Reads the `Message-ID` header value (including angle brackets) back out of
 * a raw MIME source built by `buildMime`. Used wherever a caller only has
 * the assembled MIME text and needs the id back: IMAP `APPEND`'s
 * `APPENDUID` fallback search, and reporting the real `Message-ID` after an
 * SMTP submit that sent the message via `raw` (nodemailer never parses a
 * `raw` message, so it cannot report this value itself).
 */
export function extractMessageId(mime: string): string | null {
  const match = /^Message-ID:\s*(<[^\r\n]+>)/im.exec(headerBlockOf(mime));
  return match ? (match[1] ?? null) : null;
}

/**
 * Reads the `To` header's raw value back out of a MIME source built by
 * `buildMime`. Used by `SmtpImapMailProvider.sendDraft` to recover the SMTP
 * envelope recipient from the exact bytes read back out of the Drafts
 * folder — the only place that recipient still exists once `sendDraft` is
 * called with nothing but `draftId`/`outreachId`/`mailboxId`.
 *
 * Returns the header's raw value verbatim — `buildMime` always writes a
 * bare address here (see `assertNoHeaderInjection("recipient", ...)`), but
 * a general RFC 5322 `To` value may carry a `"Display Name" <addr>` form.
 * Callers that need a bare address for an SMTP envelope (as `sendDraft`
 * does) rely on `nodemailer`/the SMTP server to extract it from an
 * angle-bracketed address, not on this function to have already stripped
 * it — it does not parse addresses, only reads the header text back.
 */
export function extractRecipient(mime: string): string | null {
  const match = /^To:\s*([^\r\n]+)/im.exec(headerBlockOf(mime));
  return match ? (match[1]?.trim() ?? null) : null;
}
