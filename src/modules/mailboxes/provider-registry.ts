import type { AppDatabase } from "@/lib/db/types";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import type {
  MailProvider,
  MailProviderKind,
} from "@/modules/mailboxes/mail-provider";

export type MailProviderDependencies = {
  microsoftConfig?: MicrosoftConfig;
  /** Normally threaded from the single top-level `process.env` read
   * (`createWorkflowTaskServices`'s default parameter), down through
   * `service-factory.ts`'s `mailProvider()` — lets a provider that needs
   * nothing Microsoft-specific (`smtp_imap`'s `TOKEN_ENCRYPTION_KEYS`
   * keyring) resolve its own config lazily without requiring
   * `microsoftConfig` to be built first. A factory *may* still fall back to
   * `process.env` itself when this is omitted (`provider-bootstrap.ts`'s
   * `smtp_imap` entry does, via `deps.environment ?? process.env`) — this
   * field only avoids that fallback on the real, single-injection-point
   * path; it is not a hard guarantee that no factory ever touches
   * `process.env` directly. */
  environment?: Record<string, string | undefined>;
};

export type MailboxRow = {
  id: string;
  provider: MailProviderKind;
  status: string;
};

type MailProviderFactory = (
  db: AppDatabase,
  mailbox: MailboxRow,
  deps: MailProviderDependencies,
) => Promise<MailProvider> | MailProvider;

const registry = new Map<MailProviderKind, MailProviderFactory>();

export function registerMailProvider(
  kind: MailProviderKind,
  factory: MailProviderFactory,
): void {
  registry.set(kind, factory);
}

/**
 * Wraps a provider whose construction needs real work — a database read, a
 * decryption, a config lookup — so that work happens on **first use**, never
 * while the provider is being built.
 *
 * This is a correctness requirement, not an optimization. Every caller in
 * `service-factory.ts` builds its provider in an *argument expression*:
 * `sendApprovedMessage(db, await providerForMessage(...), payload)` — outside
 * any `try`/`catch`. A factory that throws there takes down the whole task
 * run, not just the one message. `recover-stale-work` is the sharp case: it
 * processes messages first, so a single unbuildable mailbox (an operator
 * clicked "Disconnect" to fix a password, and a message stayed `approved`)
 * aborts the entire tick and starves research recovery, email resolution and
 * follow-ups of every tick, forever, with nothing to correlate it to.
 * `microsoft_graph` never had this problem: its client is lazy, so its
 * failures land *inside* the error handling the send/reconcile paths already
 * have. This gives every other provider the same shape.
 *
 * The load is memoized only on success. Caching a rejection would turn a
 * transient failure (a database blip while re-reading the mailbox row) into
 * a permanent one for the lifetime of this instance — and the send path
 * retries through the same provider object.
 */
export function lazyMailProvider(
  kind: MailProviderKind,
  load: () => Promise<MailProvider>,
): MailProvider {
  let pending: Promise<MailProvider> | null = null;
  const resolve = (): Promise<MailProvider> => {
    if (!pending) {
      pending = load().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
  return {
    kind,
    createDraft: async (input) => (await resolve()).createDraft(input),
    sendDraft: async (input) => (await resolve()).sendDraft(input),
    reconcile: async (input) => (await resolve()).reconcile(input),
  };
}

export async function resolveMailProvider(
  db: AppDatabase,
  mailbox: MailboxRow,
  deps: MailProviderDependencies,
): Promise<MailProvider> {
  const factory = registry.get(mailbox.provider);
  if (!factory) {
    throw new Error(`Unsupported mail provider: ${mailbox.provider}`);
  }
  return factory(db, mailbox, deps);
}
