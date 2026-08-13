import { z } from "zod";

const endpointSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(["tls", "starttls"]),
});

export const transportConfigSchema = z.object({
  username: z.string().trim().min(1).max(320),
  imap: endpointSchema,
  smtp: endpointSchema,
  folders: z.object({
    drafts: z.string().trim().min(1),
    sent: z.string().trim().min(1),
    inbox: z.string().trim().min(1).default("INBOX"),
  }),
});

export type MailboxTransport = z.infer<typeof transportConfigSchema>;

export function readTransport(
  settings: Record<string, unknown>,
): MailboxTransport | null {
  const parsed = transportConfigSchema.safeParse(settings.transport);
  return parsed.success ? parsed.data : null;
}

export function writeTransport(
  settings: Record<string, unknown>,
  transport: MailboxTransport,
): Record<string, unknown> {
  return { ...settings, transport };
}
