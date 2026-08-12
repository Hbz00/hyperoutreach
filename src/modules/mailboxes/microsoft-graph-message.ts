import { z } from "zod";

export const graphMessageSchema = z.object({
  id: z.string().min(1),
  internetMessageId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  subject: z.string().default(""),
  receivedDateTime: z.iso.datetime(),
  from: z.object({ emailAddress: z.object({ address: z.string().min(1) }) }),
  toRecipients: z.array(
    z.object({ emailAddress: z.object({ address: z.string().min(1) }) }),
  ),
  body: z.object({
    contentType: z.enum(["text", "html", "Text", "HTML"]),
    content: z.string(),
  }),
  internetMessageHeaders: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
});

export function graphMessageToInbound(
  mailboxId: string,
  providerNotificationId: string | undefined,
  rawMessage: unknown,
) {
  const message = graphMessageSchema.parse(rawMessage);
  const headers = new Map(
    message.internetMessageHeaders.map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
  const references = (headers.get("references") ?? "").match(/<[^>]+>/g) ?? [];
  const failedRecipient = headers
    .get("x-failed-recipients")
    ?.split(/[;,]/)[0]
    ?.trim();
  const statusEvidence = [
    headers.get("status"),
    message.body.content.slice(0, 20_000),
  ]
    .filter(Boolean)
    .join("\n");
  const enhancedStatus = statusEvidence.match(/\b([45])\.\d{1,3}\.\d{1,3}\b/);
  const bounceKind = failedRecipient
    ? enhancedStatus?.[1] === "5"
      ? ("hard" as const)
      : enhancedStatus?.[1] === "4"
        ? ("soft" as const)
        : undefined
    : undefined;
  return {
    mailboxId,
    providerMessageId: message.id,
    providerNotificationId,
    internetMessageId: message.internetMessageId ?? undefined,
    conversationId: message.conversationId ?? undefined,
    inReplyTo: headers.get("in-reply-to"),
    references,
    outreachId: headers.get("x-outreach-id"),
    sender: message.from.emailAddress.address,
    recipient: message.toRecipients[0]?.emailAddress.address ?? "",
    subject: message.subject.slice(0, 10_000),
    body: message.body.content.slice(0, 1_000_000),
    bounceKind,
    bouncedRecipient: bounceKind ? failedRecipient : undefined,
    receivedAt: new Date(message.receivedDateTime),
    metadata: {
      provider: "microsoft_graph",
      graphContentType: message.body.contentType.toLowerCase(),
      graphBodyTruncated: message.body.content.length > 1_000_000,
      ...(failedRecipient && !bounceKind
        ? { unclassifiedFailedRecipient: failedRecipient }
        : {}),
    },
  };
}
