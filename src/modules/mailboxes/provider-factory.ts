import { eq } from "drizzle-orm";

import { mailboxConnections } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { MailProvider } from "@/modules/mailboxes/mail-provider";
import "@/modules/mailboxes/provider-bootstrap";
import { DatabaseMockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import {
  resolveMailProvider,
  type MailProviderDependencies,
} from "@/modules/mailboxes/provider-registry";

export async function createMailProviderForMailbox(
  db: AppDatabase,
  mailboxId: string | null,
  options: MailProviderDependencies = {},
): Promise<MailProvider> {
  if (!mailboxId) return new DatabaseMockMailProvider(db);
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (!mailbox) throw new Error("Mailbox not found");
  return resolveMailProvider(db, mailbox, options);
}
