const SMTP_ERROR_CODES = new Set([
  "EAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EPROTOCOL",
  "ETLS",
  "EDNS",
]);

/** Persist protocol codes only. Server prose can contain credentials or mail content. */
export function summarizeSmtpDiagnostic(input: {
  responseCode?: unknown;
  response?: unknown;
  smtpErrorCode?: unknown;
}): {
  responseCode: number | null;
  response: string;
  smtpErrorCode: string | null;
} {
  const responseCode =
    typeof input.responseCode === "number" &&
    Number.isInteger(input.responseCode) &&
    input.responseCode >= 400 &&
    input.responseCode < 600
      ? input.responseCode
      : null;
  // Keep the enhanced status used by envelope-bounce reconciliation, without
  // carrying any surrounding prose. Its class must agree with the SMTP code.
  // A multiline SMTP reply repeats this status after the 550- prefix; its
  // final space-prefixed line can fall beyond our bounded diagnostic read.
  const enhanced =
    typeof input.response === "string"
      ? /(?:^|\s|^[45]\d{2}-)([45]\.\d{1,3}\.\d{1,3})(?=\s|$)/m.exec(
          input.response.slice(0, 1_000),
        )?.[1]
      : undefined;
  const status =
    responseCode && enhanced?.[0] === String(responseCode)[0]
      ? ` ${enhanced}`
      : "";
  return {
    responseCode,
    response: responseCode ? `SMTP ${responseCode}${status}` : "SMTP rejection",
    smtpErrorCode:
      typeof input.smtpErrorCode === "string" &&
      SMTP_ERROR_CODES.has(input.smtpErrorCode)
        ? input.smtpErrorCode
        : null,
  };
}
