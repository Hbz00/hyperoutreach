import type { AppDatabase } from "@/lib/db/types";
import {
  defaultInboundCursorEvents,
  defaultInboundNaming,
  type InboundCursorEvents,
  type InboundHealthOptions,
} from "@/modules/mailboxes/inbound-reconciliation";
import type { InboundMailSource } from "@/modules/mailboxes/inbound-source";
import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

export type InboundSourceDependencies = {
  environment: Record<string, string | undefined>;
};

export type InboundMailboxRow = {
  id: string;
  provider: MailProviderKind;
  status: string;
  syncCursor: string | null;
  lastSyncedAt: Date | null;
};

/**
 * Everything the "reconcile-inbound-mailbox" task needs for one provider:
 * how to build its source, and how to name the round. Naming/cursor events
 * are data on the entry — not a branch in the caller — so a provider that
 * needs to keep historical literals (Graph) supplies them here instead of
 * the dispatcher special-casing it by name.
 */
export type InboundProviderEntry = {
  createSource: (
    db: AppDatabase,
    mailbox: InboundMailboxRow,
    deps: InboundSourceDependencies,
  ) => Promise<InboundMailSource> | InboundMailSource;
  naming: (mailboxId: string) => InboundHealthOptions;
  cursorEvents: () => InboundCursorEvents;
  /**
   * Set when a provider has no real inbox to reconcile (e.g. `mock`): the
   * task reports `{ skipped: true, reason }` instead of running a health
   * tracked round that would otherwise claim a synced/failed outcome for
   * work that never happened.
   */
  skipReason?: string;
};

const registry = new Map<MailProviderKind, InboundProviderEntry>();

export function registerInboundProvider(
  kind: MailProviderKind,
  entry: InboundProviderEntry,
): void {
  registry.set(kind, entry);
}

/**
 * Never throws. A kind with no registered entry (e.g. `smtp_imap` before its
 * source lands) resolves to a stand-in whose naming is the generic
 * `defaultInboundNaming`/`defaultInboundCursorEvents` and whose
 * `createSource` throws lazily — so the failure surfaces *inside* the health
 * wrapper the caller wraps around it, landing a failed audit event instead
 * of aborting before one can be written. That failed event is what keeps
 * the send gate closed for a provider nobody has wired up yet.
 */
export function resolveInboundProvider(
  kind: MailProviderKind,
): InboundProviderEntry {
  return (
    registry.get(kind) ?? {
      createSource: () => {
        throw new Error(`Unsupported mail provider: ${kind}`);
      },
      naming: (mailboxId) => defaultInboundNaming(kind, mailboxId),
      cursorEvents: () => defaultInboundCursorEvents(kind),
    }
  );
}
