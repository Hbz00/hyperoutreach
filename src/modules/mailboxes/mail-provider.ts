export type MailDraftInput = {
  outreachId: string;
  mailboxId: string | null;
  sender: string | null;
  recipient: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type MailProviderKind = "mock" | "microsoft_graph";

export type MailDraft = { draftId: string };

export type SentMail = {
  providerMessageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
};

export type SendDraftAcceptance = { status: "accepted" };

export type MailReconciliation =
  | ({ status: "drafted" } & MailDraft)
  | ({ status: "accepted" } & MailDraft)
  | ({ status: "sent"; draftId: string } & SentMail)
  | null;

export interface MailProvider {
  readonly kind: MailProviderKind;
  createDraft(input: MailDraftInput): Promise<MailDraft>;
  sendDraft(input: {
    draftId: string;
    outreachId: string;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<SendDraftAcceptance>;
  reconcile(input: {
    outreachId: string;
    draftId: string | null;
    mailboxId: string | null;
    signal?: AbortSignal;
  }): Promise<MailReconciliation>;
}
