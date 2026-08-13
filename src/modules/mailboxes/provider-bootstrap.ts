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
import { SmtpClient } from "@/lib/smtp-imap/smtp-client";
import { readTransport } from "@/lib/smtp-imap/transport-config";
import { MicrosoftGraphMailProvider } from "@/modules/mailboxes/microsoft-graph-mail-provider";
import { createMailboxGraphClient } from "@/modules/mailboxes/microsoft-oauth-service";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import {
  lazyMailProvider,
  registerMailProvider,
} from "@/modules/mailboxes/provider-registry";
import { SmtpImapMailProvider } from "@/modules/mailboxes/smtp-imap-mail-provider";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";

registerMailProvider("mock", (db) => new DatabaseMockMailProvider(db));

/**
 * The Microsoft configuration is resolved **per mailbox, here**, from an
 * explicitly injected config when a caller already has one and otherwise
 * from the environment — never from a global `MAIL_PROVIDER` switch decided
 * by the caller (design doc §5). That switch used to live in
 * `service-factory.ts`'s `mailProvider()` and coupled the two providers in
 * both directions: with `MAIL_PROVIDER=microsoft_graph`, every operation on
 * an `smtp_imap` mailbox required the Microsoft configuration to still be
 * valid; flip the variable and every Graph mailbox threw instead. A mailbox's
 * own `provider` column is the only thing that decides what it needs.
 */
registerMailProvider("microsoft_graph", (db, mailbox, deps) => {
  const config =
    deps.microsoftConfig ??
    requireMicrosoftConfig(deps.environment ?? process.env);
  return new MicrosoftGraphMailProvider(
    createMailboxGraphClient(db, config, mailbox.id),
    mailbox.id,
  );
});

/**
 * Lazily self-sufficient, unlike `microsoft_graph` above: nothing here
 * touches `deps.microsoftConfig`, so an `smtp_imap` mailbox never requires
 * `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/etc. to be configured at
 * all (design doc §5). It re-reads the mailbox row itself rather than
 * trusting the narrow `MailboxRow` the registry hands in — the same
 * lazy-lookup shape `microsoft_graph`'s own token refresh uses
 * (`microsoft-oauth-service.ts`'s `refreshAccessToken`) — so the registry's
 * public `MailboxRow` type never needs widening for one provider's sake.
 */
registerMailProvider("smtp_imap", (db, mailbox, deps) =>
  // `lazyMailProvider`, not a bare `async` factory: everything below can
  // legitimately fail on a mailbox an operator just disconnected (no
  // password, no transport) and those failures must surface where the
  // callers already handle them — on `createDraft`/`sendDraft`/`reconcile`,
  // inside `send-service.ts`'s own error handling — not while the provider
  // is being constructed in an argument expression outside every `try`.
  // See that helper's doc comment for the whole-tick abort this prevents.
  lazyMailProvider("smtp_imap", async () => {
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

    const keyring = requireTokenEncryptionKeyring(
      deps.environment ?? process.env,
    );
    const credentials: MailboxCredentials = {
      user: transport.username,
      pass: decryptSecret(row.encryptedPassword, keyring).plaintext,
    };

    return new SmtpImapMailProvider(
      new ImapClient(transport, credentials),
      new SmtpClient(transport, credentials),
      row.id,
      row.email,
      new WorkflowEventsSendJournal(db),
    );
  }),
);
