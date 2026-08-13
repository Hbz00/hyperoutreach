import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

export type InboundFetchResult = {
  nextCursor: string;
  rebaselined: boolean;
};

export interface InboundMailSource {
  readonly kind: MailProviderKind;
  /**
   * Walks everything published since `cursor`, handing each page to
   * `ingestPage` as it is retrieved — never accumulating the whole backlog —
   * and returns the cursor the next round should resume from.
   *
   * `ingestPage` returns how many messages of that page were newly processed.
   * A page that cannot be ingested throws, which leaves the earlier pages
   * ingested and aborts the round without advancing the cursor.
   */
  fetchSince(
    cursor: string | null,
    ingestPage: (messages: unknown[]) => Promise<number>,
  ): Promise<InboundFetchResult>;
}
