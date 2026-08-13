/**
 * Throws an `AbortError` `DOMException` when `signal` is already aborted.
 * Shared by `ImapClient` and `SmtpClient` so a caller that passes an
 * already-aborted signal (e.g. a request whose `MailDraftInput.signal`
 * fired before the client got scheduled) never pays for opening a
 * connection just to immediately tear it down.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}
