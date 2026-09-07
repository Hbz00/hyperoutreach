import "server-only";

import { getDatabase } from "@/lib/db/client";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { getMicrosoftAccessToken } from "@/modules/mailboxes/microsoft-oauth-service";

export function getMicrosoftServerContext() {
  const db = getDatabase();
  const config = requireMicrosoftConfig(process.env);
  const graphForMailbox = (mailboxId: string, mailboxDb = db) =>
    new MicrosoftGraphClient({
      accessToken: () => getMicrosoftAccessToken(mailboxDb, config, mailboxId),
    });
  return { db, config, graphForMailbox };
}
