import { z } from "zod";

import type { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import type {
  MailDraft,
  MailDraftInput,
  MailProvider,
  MailReconciliation,
  SendDraftAcceptance,
} from "@/modules/mailboxes/mail-provider";

const messageSchema = z.object({
  id: z.string().min(1),
  internetMessageId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  isDraft: z.boolean(),
});

export class MicrosoftGraphMailProvider implements MailProvider {
  readonly kind = "microsoft_graph" as const;

  constructor(
    private readonly client: MicrosoftGraphClient,
    private readonly boundMailboxId: string,
  ) {}

  private assertMailbox(mailboxId: string | null): void {
    if (mailboxId !== this.boundMailboxId) {
      throw new Error("Microsoft Graph provider mailbox binding mismatch");
    }
  }

  async createDraft(input: MailDraftInput): Promise<MailDraft> {
    this.assertMailbox(input.mailboxId);
    const unexpectedHeader = Object.keys(input.headers).find(
      (name) =>
        !name.toLowerCase().startsWith("x-") ||
        /[\r\n]/.test(name) ||
        /[\r\n]/.test(input.headers[name] ?? ""),
    );
    if (unexpectedHeader) {
      throw new Error("Invalid custom mail header");
    }
    const headers = new Map(
      Object.entries({
        ...input.headers,
        "X-Outreach-ID": input.outreachId,
      }).map(([name, value]) => [name.toLowerCase(), { name, value }]),
    );
    const raw = await this.client.post<unknown>(
      "/me/messages",
      {
        subject: input.subject,
        body: { contentType: "Text", content: input.body },
        toRecipients: [{ emailAddress: { address: input.recipient } }],
        internetMessageHeaders: [...headers.values()],
      },
      input.signal,
    );
    const message = messageSchema.parse(raw);
    if (!message.isDraft)
      throw new Error("Microsoft Graph did not create a draft");
    return { draftId: message.id };
  }

  async sendDraft(input: {
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<SendDraftAcceptance> {
    this.assertMailbox(input.mailboxId);
    await this.client.post<void>(
      `/me/messages/${encodeURIComponent(input.draftId)}/send`,
      undefined,
      input.signal,
    );
    return { status: "accepted" };
  }

  async reconcile(input: {
    outreachId: string;
    draftId: string | null;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<MailReconciliation> {
    this.assertMailbox(input.mailboxId);
    if (!input.draftId) return null;
    try {
      const raw = await this.client.get<unknown>(
        `/me/messages/${encodeURIComponent(input.draftId)}?$select=id,internetMessageId,conversationId,isDraft,internetMessageHeaders`,
        input.signal,
      );
      const message = messageSchema.parse(raw);
      if (message.isDraft) return { status: "drafted", draftId: message.id };
      return {
        status: "sent",
        draftId: message.id,
        providerMessageId: message.id,
        internetMessageId: message.internetMessageId ?? null,
        conversationId: message.conversationId ?? null,
      };
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
