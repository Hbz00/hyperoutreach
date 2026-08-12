import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

const resourceNotificationSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  subscriptionId: z.string().min(1).max(500),
  changeType: z.enum(["created", "updated", "deleted"]),
  resource: z.string().min(1).max(2_000),
  clientState: z.string().min(1).max(128),
  resourceData: z.object({ id: z.string().min(1).max(1_000) }),
});

const lifecycleNotificationSchema = z.object({
  id: z.string().min(1).max(500).optional(),
  subscriptionId: z.string().min(1).max(500),
  clientState: z.string().min(1).max(128),
  lifecycleEvent: z.enum([
    "reauthorizationRequired",
    "subscriptionRemoved",
    "missed",
  ]),
});

const payloadSchema = z.object({
  value: z
    .array(z.union([resourceNotificationSchema, lifecycleNotificationSchema]))
    .min(1)
    .max(1_000),
});

export type GraphNotification = z.infer<typeof resourceNotificationSchema>;
export type GraphLifecycleNotification = z.infer<
  typeof lifecycleNotificationSchema
>;

export function parseGraphNotifications(
  input: unknown,
): Array<GraphNotification | GraphLifecycleNotification> {
  return payloadSchema.parse(input).value;
}

export function validateWebhookClientState(
  received: string,
  expected: string,
): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
