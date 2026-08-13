import { describe, expect, it } from "vitest";

import {
  classifySmtpRejection,
  SmtpRejectionError,
} from "@/lib/smtp-imap/smtp-client";

/**
 * `classifySmtpRejection` is exported standalone precisely so it can be
 * exercised against fabricated, nodemailer-shaped error objects — no real
 * (or fake) SMTP connection required. The shapes below mirror exactly what
 * `node_modules/nodemailer/lib/smtp-connection/index.js`'s `_formatError`
 * actually produces for each scenario (verified by reading that file, not
 * nodemailer's docs — see `smtp-imap-mail-provider.ts`'s `SendJournal` doc
 * and the task report for the specific line numbers).
 */
function nodemailerError(opts: {
  message: string;
  code?: string;
  response?: string;
  responseCode?: number;
}): Error {
  const err = new Error(opts.message) as Error & {
    code?: string;
    response?: string;
    responseCode?: number;
  };
  if (opts.code !== undefined) err.code = opts.code;
  if (opts.response !== undefined) err.response = opts.response;
  if (opts.responseCode !== undefined) err.responseCode = opts.responseCode;
  return err;
}

describe("classifySmtpRejection", () => {
  it("classifies a 451 RCPT TO refusal (SMTP greylisting) as a definite rejection", () => {
    // `_actionRCPT` / `_actionMAIL`'s shape when every recipient is
    // rejected: `code: 'EENVELOPE'`, `response` the raw server line,
    // `responseCode` parsed from its leading digits.
    const error = nodemailerError({
      message:
        "Recipient command failed: 451 4.7.1 Greylisted, try again later",
      code: "EENVELOPE",
      response: "451 4.7.1 Greylisted, try again later",
      responseCode: 451,
    });

    expect(classifySmtpRejection(error)).toEqual({
      responseCode: 451,
      response: "451 4.7.1 Greylisted, try again later",
      smtpErrorCode: "EENVELOPE",
    });
  });

  it("classifies a 550 mailbox-does-not-exist refusal as a definite rejection", () => {
    const error = nodemailerError({
      message: "Recipient command failed: 550 5.1.1 No such user",
      code: "EENVELOPE",
      response: "550 5.1.1 No such user",
      responseCode: 550,
    });

    expect(classifySmtpRejection(error)).toEqual({
      responseCode: 550,
      response: "550 5.1.1 No such user",
      smtpErrorCode: "EENVELOPE",
    });
  });

  it("classifies a DATA-stage 552 content refusal (EMESSAGE) as a definite rejection", () => {
    // `_actionSMTPStream`'s shape: the final response after the message
    // body was fully transmitted, but the server still refused it.
    const error = nodemailerError({
      message: "Message failed: 552 5.2.3 Message too large",
      code: "EMESSAGE",
      response: "552 5.2.3 Message too large",
      responseCode: 552,
    });

    expect(classifySmtpRejection(error)?.responseCode).toBe(552);
  });

  it("treats a plain connection drop (no responseCode at all) as ambiguous", () => {
    // `_onSocketError`'s shape: `_onError(error, 'ESOCKET', false, 'CONN')`
    // — `response` is `false`, so `_formatError` never sets `responseCode`.
    const error = nodemailerError({
      message: "socket hang up",
      code: "ESOCKET",
    });

    expect(classifySmtpRejection(error)).toBeNull();
  });

  it("treats ETIMEDOUT as ambiguous even if something upstream attached a responseCode", () => {
    const error = nodemailerError({
      message: "Greeting never received",
      code: "ETIMEDOUT",
      responseCode: 421,
    });

    expect(classifySmtpRejection(error)).toBeNull();
  });

  // The trap this whole classifier exists to avoid: `_onClose`
  // (smtp-connection/index.js ~L990-994) — when the socket drops
  // mid-transaction, decodes whatever partial line is sitting in its read
  // buffer and, if that fragment happens to start with a `4`/`5` digit,
  // passes it through as `response`, which still populates
  // `err.responseCode` — while `err.code` stays `'ECONNECTION'`. This is a
  // race between the disconnect and an in-flight reply, not a completed
  // server verdict: a responseCode-only check would misclassify it as a
  // definite rejection and wrongly release the attempt for a message the
  // server may well have already accepted.
  it("treats ECONNECTION as ambiguous even when a partial buffered response looks like a 4xx/5xx", () => {
    const error = nodemailerError({
      message: "Connection closed unexpectedly",
      code: "ECONNECTION",
      response: "450",
      responseCode: 450,
    });

    expect(classifySmtpRejection(error)).toBeNull();
  });

  it("treats ECONNECTION as ambiguous even with a full-looking 5xx fragment", () => {
    const error = nodemailerError({
      message: "Connection closed unexpectedly",
      code: "ECONNECTION",
      response: "554 ",
      responseCode: 554,
    });

    expect(classifySmtpRejection(error)).toBeNull();
  });

  it("rejects a non-Error thrown value", () => {
    expect(classifySmtpRejection("boom")).toBeNull();
    expect(classifySmtpRejection(undefined)).toBeNull();
    expect(classifySmtpRejection({ responseCode: 451 })).toBeNull();
  });

  it("rejects a responseCode outside the SMTP 4xx/5xx range", () => {
    expect(
      classifySmtpRejection(
        nodemailerError({ message: "?", responseCode: 250 }),
      ),
    ).toBeNull();
    expect(
      classifySmtpRejection(
        nodemailerError({ message: "?", responseCode: 999 }),
      ),
    ).toBeNull();
  });

  it("rejects a non-integer or non-numeric responseCode", () => {
    const error = nodemailerError({ message: "?" }) as Error & {
      responseCode?: unknown;
    };
    error.responseCode = "451";
    expect(classifySmtpRejection(error)).toBeNull();

    const fractional = nodemailerError({ message: "?" }) as Error & {
      responseCode?: unknown;
    };
    fractional.responseCode = 451.5;
    expect(classifySmtpRejection(fractional)).toBeNull();
  });

  it("classifies an authentication failure (EAUTH) with a server responseCode as a definite rejection", () => {
    // Auth failures fire before MAIL FROM is ever sent, so "the message
    // was never accepted" is certain here too.
    const error = nodemailerError({
      message: "Invalid login: 535 5.7.8 Authentication failed",
      code: "EAUTH",
      response: "535 5.7.8 Authentication failed",
      responseCode: 535,
    });

    expect(classifySmtpRejection(error)).toEqual({
      responseCode: 535,
      response: "535 5.7.8 Authentication failed",
      smtpErrorCode: "EAUTH",
    });
  });
});

describe("SmtpRejectionError", () => {
  it("carries the response code, raw response, and nodemailer error code", () => {
    const error = new SmtpRejectionError(
      "Recipient command failed",
      451,
      "451 Greylisted",
      "EENVELOPE",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SmtpRejectionError");
    expect(error.responseCode).toBe(451);
    expect(error.response).toBe("451 Greylisted");
    expect(error.smtpErrorCode).toBe("EENVELOPE");
  });
});
