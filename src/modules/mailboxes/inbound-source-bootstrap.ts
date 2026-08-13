import { eq } from "drizzle-orm";

import { mailboxConnections } from "@/lib/db/schema";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import {
  decryptSecret,
  requireTokenEncryptionKeyring,
} from "@/lib/microsoft/token-crypto";
import {
  ImapClient,
  type MailboxCredentials,
} from "@/lib/smtp-imap/imap-client";
import { readTransport } from "@/lib/smtp-imap/transport-config";
import {
  defaultInboundCursorEvents,
  defaultInboundNaming,
} from "@/modules/mailboxes/inbound-reconciliation";
import { registerInboundProvider } from "@/modules/mailboxes/inbound-source-registry";
import { createMicrosoftGraphInboundSource } from "@/modules/mailboxes/microsoft-graph-inbound-source";
import {
  graphDeltaCursorEvents,
  graphDeltaHealthOptions,
} from "@/modules/mailboxes/microsoft-graph-inbound-naming";
import { createMailboxGraphClient } from "@/modules/mailboxes/microsoft-oauth-service";
import { SmtpImapInboundSource } from "@/modules/mailboxes/smtp-imap-inbound-source";

// `mock` has no real inbox: `skipReason` tells the task to report
// `{ skipped: true }` instead of running (and health-tracking) a round that
// never reads anything. `createSource` still exists — it genuinely is an
// empty source per the design (naming/cursor events fall back to the same
// generic defaults any unnamed provider would get) — it's just never
// reached while skipReason is set.
registerInboundProvider("mock", {
  createSource: () => ({
    kind: "mock",
    async fetchSince(cursor) {
      return { nextCursor: cursor ?? "", rebaselined: false };
    },
  }),
  naming: (mailboxId) => defaultInboundNaming("mock", mailboxId),
  cursorEvents: () => defaultInboundCursorEvents("mock"),
  skipReason: "mock_has_no_inbox",
});

// Graph predates the shared naming and keeps its own literal keys and event
// names: the send gate in send-service.ts reads the `graph_delta_health`
// workflow directly, and operators watch these event names. `naming` and
// `cursorEvents` are sourced from microsoft-graph-inbound-naming.ts — the
// same pure constants module `reconcileGraphDelta` reads — so this entry
// cannot drift from that function's literals; there is exactly one place
// that defines them, not two copies that merely start out identical. That
// single module is what lets the "reconcile-inbound-mailbox" dispatcher use
// one code path for every provider instead of branching on
// `mailbox.provider`.
//
// `reconcileGraphDelta` itself is unchanged and keeps its own callers
// (webhook/lifecycle/stale recovery) — this entry only serves the generic
// task dispatch, and resolves its Microsoft config lazily, at round time,
// inside the health wrapper the caller supplies.
registerInboundProvider("microsoft_graph", {
  createSource: (db, mailbox, deps) => {
    // Preserved from `reconcileGraphDelta`: a mailbox with neither an anchor
    // nor a cursor hasn't finished connecting yet, and syncing "since epoch"
    // would be wrong, not just incomplete.
    if (!mailbox.lastSyncedAt && !mailbox.syncCursor) {
      throw new Error("Microsoft mailbox sync anchor is missing");
    }
    const config = requireMicrosoftConfig(deps.environment);
    const graph = createMailboxGraphClient(db, config, mailbox.id);
    return createMicrosoftGraphInboundSource(graph, {
      id: mailbox.id,
      since: mailbox.lastSyncedAt ?? new Date(0),
    });
  },
  naming: graphDeltaHealthOptions,
  cursorEvents: graphDeltaCursorEvents,
});

// Mirrors `provider-bootstrap.ts`'s `smtp_imap` outbound registration: no
// `deps.microsoftConfig` touched, and the mailbox row is re-read here rather
// than trusted from the narrow `InboundMailboxRow` the registry hands in —
// same lazy, self-sufficient shape, same reason (design doc §5).
//
// Naming/cursor events use the generic defaults (no legacy literals to
// preserve, unlike Graph): `smtp_imap.inbound_failed`/`_synced`/
// `_rebaselined`, `inbound-delta:smtp_imap:<id>` lock key.
//
// No `skipReason`: unlike `mock`, an smtp_imap mailbox has a real inbox to
// reconcile, so a round that can't build a source (missing password,
// invalid transport config) must fail loudly *inside* the health wrapper —
// exactly the fail-safe `workflow-runtime.test.ts` pins down — not report
// `{ skipped: true }`.
registerInboundProvider("smtp_imap", {
  createSource: async (db, mailbox, deps) => {
    // Same guard as `microsoft_graph` above, same reason: a mailbox with
    // neither an anchor nor a cursor hasn't finished connecting yet.
    // Distinct from that guard's outcome for IMAP specifically: without it,
    // `SmtpImapInboundSource` would default to an unbounded first walk
    // (uid 1) instead of `since`-bounding it — for a mailbox with years of
    // history, that means one long-lived IMAP connection classifying every
    // message it ever received before the round can succeed (see
    // `imap-client.ts`'s `fetchRange` doc comment on why that connection's
    // `socketTimeout` is the real ceiling), reporting `failed` and leaving
    // the send gate closed for as long as onboarding takes.
    if (!mailbox.lastSyncedAt && !mailbox.syncCursor) {
      throw new Error("smtp_imap mailbox sync anchor is missing");
    }
    const [row] = await db
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, mailbox.id))
      .limit(1);
    if (!row || row.provider !== "smtp_imap") {
      throw new Error("smtp_imap mailbox not found");
    }
    if (!row.encryptedPassword) {
      throw new Error("smtp_imap mailbox has no stored password");
    }
    const transport = readTransport(row.settings);
    if (!transport) {
      throw new Error(
        "smtp_imap mailbox is missing a valid transport configuration",
      );
    }

    const keyring = requireTokenEncryptionKeyring(deps.environment);
    const credentials: MailboxCredentials = {
      user: transport.username,
      pass: decryptSecret(row.encryptedPassword, keyring).plaintext,
    };

    return new SmtpImapInboundSource(
      new ImapClient(transport, credentials),
      row.id,
      row.email,
      mailbox.lastSyncedAt ?? new Date(0),
    );
  },
  naming: (mailboxId) => defaultInboundNaming("smtp_imap", mailboxId),
  cursorEvents: () => defaultInboundCursorEvents("smtp_imap"),
});
