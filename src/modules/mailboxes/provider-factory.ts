import { eq } from "drizzle-orm";

import { mailboxConnections } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import type { MailProvider } from "@/modules/mailboxes/mail-provider";
import { MicrosoftGraphMailProvider } from "@/modules/mailboxes/microsoft-graph-mail-provider";
import { getMicrosoftAccessToken } from "@/modules/mailboxes/microsoft-oauth-service";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";

export async function createMailProviderForMailbox(
  db: AppDatabase,
  mailboxId: string | null,
  options: { microsoftConfig?: MicrosoftConfig } = {},
): Promise<MailProvider> {
  if (!mailboxId) return new DatabaseMockMailProvider(db);
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (!mailbox) throw new Error("Mailbox not found");
  if (mailbox.provider === "mock") return new DatabaseMockMailProvider(db);
  if (!options.microsoftConfig) {
    throw new Error("Microsoft Graph configuration is required");
  }
  const config = options.microsoftConfig;
  return new MicrosoftGraphMailProvider(
    new MicrosoftGraphClient({
      accessToken: () => getMicrosoftAccessToken(db, config, mailbox.id),
    }),
    mailbox.id,
  );
}
