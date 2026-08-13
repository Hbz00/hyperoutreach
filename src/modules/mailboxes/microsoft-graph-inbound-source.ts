import { z } from "zod";

import {
  GraphApiError,
  type MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import type { InboundMailSource } from "@/modules/mailboxes/inbound-source";
import {
  graphMessageSchema,
  graphMessageToInbound,
} from "@/modules/mailboxes/microsoft-graph-message";

const deltaPageSchema = z.object({
  value: z.array(z.unknown()),
  "@odata.nextLink": z.url().optional(),
  "@odata.deltaLink": z.url().optional(),
});

const DELTA_SELECT =
  "id,internetMessageId,conversationId,subject,receivedDateTime,from,toRecipients,body,internetMessageHeaders";

/**
 * Inbound source backed by the Graph message delta query. The cursor is the
 * opaque `@odata.deltaLink` Graph hands back at the end of a round; when Graph
 * rejects it as expired the source restarts once from the mailbox anchor and
 * reports the round as rebaselined.
 */
export function createMicrosoftGraphInboundSource(
  graph: MicrosoftGraphClient,
  mailbox: { id: string; since: Date },
): InboundMailSource {
  const filter = encodeURIComponent(
    `receivedDateTime ge ${mailbox.since.toISOString()}`,
  );
  const initial = `/me/mailFolders/Inbox/messages/delta?changeType=created&$select=${DELTA_SELECT}&$filter=${filter}`;
  return {
    kind: "microsoft_graph",
    async fetchSince(cursor, ingestPage) {
      let url = cursor ?? initial;
      let rebaselined = false;
      let finalDeltaLink: string | undefined;
      for (;;) {
        let page;
        try {
          page = deltaPageSchema.parse(await graph.get<unknown>(url));
        } catch (error) {
          if (
            !rebaselined &&
            error instanceof GraphApiError &&
            (error.status === 410 || error.code === "syncStateNotFound")
          ) {
            // Whatever the expired token already yielded stays ingested; the
            // restart replays it from the anchor and ingestion is idempotent.
            rebaselined = true;
            url = initial;
            continue;
          }
          throw error;
        }
        const messages: unknown[] = [];
        for (const raw of page.value) {
          if (typeof raw === "object" && raw !== null && "@removed" in raw) {
            continue;
          }
          const parsedMessage = graphMessageSchema.safeParse(raw);
          if (!parsedMessage.success) continue;
          messages.push(
            graphMessageToInbound(
              mailbox.id,
              `delta:${parsedMessage.data.id}`,
              parsedMessage.data,
            ),
          );
        }
        // Ingest before requesting the next page: a page that fails must not
        // discard the pages already persisted.
        await ingestPage(messages);
        const next = page["@odata.nextLink"];
        if (next) {
          url = next;
          continue;
        }
        finalDeltaLink = page["@odata.deltaLink"];
        break;
      }
      if (!finalDeltaLink)
        throw new Error("Microsoft Graph delta did not return a deltaLink");
      return { nextCursor: finalDeltaLink, rebaselined };
    },
  };
}
