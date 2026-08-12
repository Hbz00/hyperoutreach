import "server-only";

import { getDatabase } from "@/lib/db/client";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { getMicrosoftAccessToken } from "@/modules/mailboxes/microsoft-oauth-service";

export function getMicrosoftServerContext() {
  const db = getDatabase();
  const config = requireMicrosoftConfig(process.env);
  const graphForMailbox = (mailboxId: string) =>
    new MicrosoftGraphClient({
      accessToken: () => getMicrosoftAccessToken(db, config, mailboxId),
    });
  return { db, config, graphForMailbox };
}
