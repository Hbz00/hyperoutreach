/**
 * Derives a deterministic Message-ID from an outreach id, with no randomness
 * and no clock. `sendApprovedMessage` calls `reconcile` before `createDraft`
 * and only creates a draft when none is found (`send-service.ts:1081`,
 * `:1192`); if the process dies between the IMAP `APPEND` and persisting the
 * provider draft id, an orphaned draft must remain findable by recomputing
 * this same value from the outreach id alone. Two calls with the same
 * `outreachId` must always produce the same value, in this process or any
 * other.
 */
export function outreachMessageId(outreachId: string, domain: string): string {
  return `<${encodeURIComponent(outreachId)}.hyperoutreach@${domain}>`;
}
