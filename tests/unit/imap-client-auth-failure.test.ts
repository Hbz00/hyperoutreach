import { describe, expect, it } from "vitest";

import {
  classifyImapAuthFailure,
  ImapAuthenticationError,
} from "@/lib/smtp-imap/imap-client";

/**
 * `classifyImapAuthFailure` is exported standalone precisely so it can be
 * exercised against fabricated, `imapflow`-shaped error objects — no real
 * (or fake) IMAP connection required. The shapes below mirror exactly what
 * `node_modules/imapflow/lib/commands/login.js` and
 * `.../commands/authenticate.js` actually produce for each scenario
 * (verified by reading those files, not imapflow's docs — same method as
 * `classifySmtpRejection`'s tests). Both files' `catch` blocks run the
 * *same* two-step enrichment before rethrowing:
 *   1. `err.authenticationFailed = true` — unconditionally, on *any*
 *      rejection from the underlying `connection.exec()` call.
 *   2. `err.response = await getErrorText(err.response)` — a non-empty
 *      string only when there was an actual parsed tagged response to
 *      render; `false` when the promise rejected before any reply arrived.
 */
function imapflowError(opts: {
  message: string;
  authenticationFailed?: boolean;
  response?: string | false;
  code?: string;
  serverResponseCode?: string;
}): Error {
  const err = new Error(opts.message) as Error & {
    authenticationFailed?: boolean;
    response?: string | false;
    code?: string;
    serverResponseCode?: string;
  };
  if (opts.authenticationFailed !== undefined)
    err.authenticationFailed = opts.authenticationFailed;
  if (opts.response !== undefined) err.response = opts.response;
  if (opts.code !== undefined) err.code = opts.code;
  if (opts.serverResponseCode !== undefined)
    err.serverResponseCode = opts.serverResponseCode;
  return err;
}

describe("classifyImapAuthFailure", () => {
  it("classifies a plain 'NO Login failed' response (no bracketed code) as a definite auth failure", () => {
    // The common case for Dovecot/Zimbra: no [AUTHENTICATIONFAILED] response
    // code at all, just a plain-text refusal. Still a complete,
    // attributable server reply.
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response: "a2 NO Login failed",
    });

    expect(classifyImapAuthFailure(error)).toBe(true);
  });

  it("classifies a structured [AUTHENTICATIONFAILED] response as a definite auth failure", () => {
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response: "a3 NO [AUTHENTICATIONFAILED] Invalid credentials",
    });

    expect(classifyImapAuthFailure(error)).toBe(true);
  });

  it("classifies a structured [EXPIRED] response as a definite auth failure", () => {
    // Unlike the transient RFC 5530 codes below, EXPIRED is a genuine
    // credentials problem (the password/token itself has expired) -- it
    // must still revoke the mailbox, not be treated as "try again later".
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response: "a3b NO [EXPIRED] Password expired",
      serverResponseCode: "EXPIRED",
    });

    expect(classifyImapAuthFailure(error)).toBe(true);
  });

  it.each(["UNAVAILABLE", "SERVERBUG", "INUSE"])(
    "treats a transient RFC 5530 [%s] response as ambiguous, never a credentials verdict",
    (code) => {
      // login.js/authenticate.js set serverResponseCode from the bracketed
      // RFC 5530 token *before* response is reassigned to its rendered text
      // form -- both fields are present together, mirroring a real error.
      const error = imapflowError({
        message: "Command failed",
        authenticationFailed: true,
        response: `a3c NO [${code}] Temporary failure, please try again`,
        serverResponseCode: code,
      });

      expect(classifyImapAuthFailure(error)).toBe(false);
    },
  );

  it("classifies a SASL PLAIN/LOGIN rejection the same way as the classic LOGIN command", () => {
    // authenticate.js's handleAuthError is byte-for-byte the same shape as
    // login.js's catch block -- verified by reading both files.
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response: "a4 NO Authentication failed",
    });

    expect(classifyImapAuthFailure(error)).toBe(true);
  });

  // The trap this whole classifier exists to avoid: `login.js`/
  // `authenticate.js` set `authenticationFailed = true` unconditionally on
  // *any* error from `connection.exec()` -- including a connection that
  // dropped mid-command, before any server reply ever arrived. In that
  // case `getErrorText(undefined)` returns `false` (not a string), which
  // is exactly what `err.response` gets reassigned to.
  it("treats a connection drop mid-LOGIN (authenticationFailed set, but no response text) as ambiguous", () => {
    const error = imapflowError({
      message: "Socket closed unexpectedly",
      authenticationFailed: true,
      response: false,
    });

    expect(classifyImapAuthFailure(error)).toBe(false);
  });

  it("treats an error with no authenticationFailed flag at all as ambiguous", () => {
    const error = imapflowError({ message: "socket hang up" });

    expect(classifyImapAuthFailure(error)).toBe(false);
  });

  it("treats a throttled response (Microsoft 365 rate limiting) as ambiguous, never a credentials verdict", () => {
    // settleRequest tags ETHROTTLE onto *any* NO/BAD response matching the
    // throttle text pattern, including one returned for LOGIN/AUTHENTICATE
    // -- a rate limit says nothing about whether the password is correct.
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response:
        "a5 BAD Request is throttled. Suggested Backoff Time: 92415 milliseconds",
      code: "ETHROTTLE",
    });

    expect(classifyImapAuthFailure(error)).toBe(false);
  });

  it("treats an empty response string as ambiguous", () => {
    const error = imapflowError({
      message: "Command failed",
      authenticationFailed: true,
      response: "",
    });

    expect(classifyImapAuthFailure(error)).toBe(false);
  });

  it("rejects a non-Error thrown value", () => {
    expect(classifyImapAuthFailure("boom")).toBe(false);
    expect(classifyImapAuthFailure(undefined)).toBe(false);
    expect(
      classifyImapAuthFailure({ authenticationFailed: true, response: "NO" }),
    ).toBe(false);
  });

  it("rejects a non-boolean-true authenticationFailed value", () => {
    const error = new Error("weird") as Error & {
      authenticationFailed?: unknown;
      response?: unknown;
    };
    error.authenticationFailed = "true";
    error.response = "a6 NO Login failed";

    expect(classifyImapAuthFailure(error)).toBe(false);
  });
});

describe("ImapAuthenticationError", () => {
  it("is a distinguishable Error subclass", () => {
    const error = new ImapAuthenticationError("Login failed");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ImapAuthenticationError");
    expect(error.message).toBe("Login failed");
  });
});
