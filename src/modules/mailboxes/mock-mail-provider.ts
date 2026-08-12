import { and, eq, isNull } from "drizzle-orm";

import { messages, workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type {
  MailDraft,
  MailDraftInput,
  MailProvider,
  MailReconciliation,
  SendDraftAcceptance,
  SentMail,
} from "@/modules/mailboxes/mail-provider";

type StoredDraft = MailDraftInput &
  MailDraft & {
    accepted: boolean;
    confirmed: boolean;
    sent: SentMail;
  };

type MockMailProviderOptions = {
  confirmation?: "immediate" | "manual";
  throwAfterAccept?: boolean;
};

export class MockMailProvider implements MailProvider {
  readonly kind = "mock" as const;
  readonly deliveries: Array<MailDraftInput & MailDraft & SentMail> = [];
  readonly createDraftCalls: MailDraftInput[] = [];
  readonly sendDraftCalls: Array<{
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
  }> = [];
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly confirmation: "immediate" | "manual";
  private readonly throwAfterAccept: boolean;

  constructor(options: MockMailProviderOptions = {}) {
    this.confirmation = options.confirmation ?? "immediate";
    this.throwAfterAccept = options.throwAfterAccept ?? false;
  }

  async createDraft(input: MailDraftInput): Promise<MailDraft> {
    input.signal?.throwIfAborted();
    this.createDraftCalls.push(input);
    const key = this.key(input.mailboxId, input.outreachId);
    const existing = this.drafts.get(key);
    if (existing) return { draftId: existing.draftId };
    const draft: StoredDraft = {
      ...input,
      draftId: `mock-draft-${input.outreachId}`,
      accepted: false,
      confirmed: false,
      sent: {
        providerMessageId: `mock-message-${input.outreachId}`,
        internetMessageId: `<${input.outreachId}@mock.hyperoutreach>`,
        conversationId: `mock-conversation-${input.outreachId}`,
      },
    };
    this.drafts.set(key, draft);
    return { draftId: draft.draftId };
  }

  async sendDraft(input: {
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<SendDraftAcceptance> {
    input.signal?.throwIfAborted();
    this.sendDraftCalls.push(input);
    const draft = this.drafts.get(this.key(input.mailboxId, input.outreachId));
    if (!draft || draft.draftId !== input.draftId) {
      throw new Error("Mock draft not found");
    }
    if (!draft.accepted) {
      draft.accepted = true;
      draft.confirmed = this.confirmation === "immediate";
      this.deliveries.push({ ...draft, ...draft.sent });
    }
    if (this.throwAfterAccept) {
      throw new Error("Mock transport failed after acceptance");
    }
    return { status: "accepted" };
  }

  confirm(outreachId: string, mailboxId: string | null = null): void {
    const draft = this.drafts.get(this.key(mailboxId, outreachId));
    if (!draft?.accepted) throw new Error("Mock accepted delivery not found");
    draft.confirmed = true;
  }

  async reconcile(input: {
    outreachId: string;
    draftId: string | null;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<MailReconciliation> {
    input.signal?.throwIfAborted();
    const draft = this.drafts.get(this.key(input.mailboxId, input.outreachId));
    if (
      !draft ||
      draft.mailboxId !== input.mailboxId ||
      (input.draftId && input.draftId !== draft.draftId)
    ) {
      return null;
    }
    if (draft.confirmed) {
      return { status: "sent", draftId: draft.draftId, ...draft.sent };
    }
    if (draft.accepted) {
      return { status: "accepted", draftId: draft.draftId };
    }
    return { status: "drafted", draftId: draft.draftId };
  }

  private key(mailboxId: string | null, outreachId: string): string {
    return `${mailboxId ?? "local-mock"}:${outreachId}`;
  }
}

/** Restart-safe deterministic provider used by the credential-free app path. */
export class DatabaseMockMailProvider implements MailProvider {
  readonly kind = "mock" as const;

  constructor(private readonly db: AppDatabase) {}

  async createDraft(input: MailDraftInput): Promise<MailDraft> {
    input.signal?.throwIfAborted();
    return { draftId: `mock-draft-${input.outreachId}` };
  }

  async sendDraft(input: {
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<SendDraftAcceptance> {
    input.signal?.throwIfAborted();
    if (input.draftId !== `mock-draft-${input.outreachId}`) {
      throw new Error("Mock draft identity mismatch");
    }
    const message = await this.findMessage(input.outreachId, input.mailboxId);
    if (!message || message.providerDraftId !== input.draftId) {
      throw new Error("Mock draft not found");
    }
    await this.db
      .insert(workflowEvents)
      .values({
        entityType: "message",
        entityId: message.id,
        event: "mock_mail.accepted",
        workflowName: "mock_mail_provider",
        idempotencyKey: `mock-mail-accepted:${message.id}`,
        status: "succeeded",
        completedAt: new Date(),
        payload: { outreachId: input.outreachId, draftId: input.draftId },
      })
      .onConflictDoNothing();
    return { status: "accepted" };
  }

  async reconcile(input: {
    outreachId: string;
    draftId: string | null;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<MailReconciliation> {
    input.signal?.throwIfAborted();
    const message = await this.findMessage(input.outreachId, input.mailboxId);
    if (!message?.providerDraftId) return null;
    if (input.draftId && input.draftId !== message.providerDraftId) return null;
    const [acceptance] = await this.db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(
        eq(workflowEvents.idempotencyKey, `mock-mail-accepted:${message.id}`),
      )
      .limit(1);
    if (message.status === "sent" || acceptance) {
      return {
        status: "sent",
        draftId: message.providerDraftId,
        providerMessageId:
          message.providerMessageId ?? `mock-message-${input.outreachId}`,
        internetMessageId:
          message.internetMessageId ??
          `<${input.outreachId}@mock.hyperoutreach>`,
        conversationId:
          message.conversationId ?? `mock-conversation-${input.outreachId}`,
      };
    }
    return { status: "drafted", draftId: message.providerDraftId };
  }

  private async findMessage(outreachId: string, mailboxId: string | null) {
    const [message] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.outreachId, outreachId),
          mailboxId === null
            ? isNull(messages.mailboxId)
            : eq(messages.mailboxId, mailboxId),
        ),
      )
      .limit(1);
    return message;
  }
}
