import { z } from "zod";

const sequenceStepSchema = z.object({
  delayMinutes: z.number().int().min(0).max(525_600),
  subjectTemplate: z.string().trim().min(1).max(998),
  bodyTemplate: z.string().trim().min(1).max(100_000),
});

export const campaignConfigurationSchema = z
  .object({
    reviewMode: z.enum(["manual", "assisted", "automatic"]).optional(),
    automaticFollowUps: z.boolean().optional(),
    holdNonTerminalReplies: z.boolean().optional(),
    requireProfessionalRelevance: z.boolean().optional(),
    campaignDailyCap: z.number().int().positive().max(10_000).optional(),
  })
  .catchall(z.unknown());

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(300),
  type: z.enum(["customer_discovery", "commercial_outreach", "other"]),
  targetDescription: z.string().trim().min(10).max(10_000),
  configuration: campaignConfigurationSchema,
  steps: z.array(sequenceStepSchema).min(1).max(20),
});

export const publishCampaignSchema = z.object({
  campaignId: z.uuid(),
  campaignVersionId: z.uuid(),
});

export const reviseCampaignSchema = z.object({
  campaignId: z.uuid(),
  baseVersionId: z.uuid(),
  configuration: campaignConfigurationSchema,
  steps: z.array(sequenceStepSchema).min(1).max(20),
});

export const enrollContactSchema = z.object({
  campaignId: z.uuid(),
  campaignVersionId: z.uuid(),
  contactId: z.uuid(),
  mailboxId: z.uuid().nullable().optional(),
});
