import { z } from "zod";

import { reasoningVariablesUsed } from "@/modules/messages/interpolation";

/**
 * What a step asks an agent to write, if anything.
 *
 * `minConfidence` gates whether a message is produced at all, not whether it
 * is approved — those are different decisions and only the first is made here.
 * The default is `0.5` because the in-tree deterministic agent returns exactly
 * that: a stricter default would silently stop every mock-backed test from
 * producing a message, and the number to raise it to is an empirical question
 * the operator answers after measuring the real model.
 */
const personalizationDeclarationSchema = z
  .object({
    fields: z
      .array(z.enum(["company_relevance", "personalized_opening"]))
      .min(1)
      .max(2),
    minConfidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export type PersonalizationDeclaration = z.infer<
  typeof personalizationDeclarationSchema
>;

const sequenceStepSchema = z
  .object({
    delayMinutes: z.number().int().min(0).max(525_600),
    subjectTemplate: z.string().trim().min(1).max(998),
    bodyTemplate: z.string().trim().min(1).max(100_000),
    personalizationSchema: personalizationDeclarationSchema.optional(),
  })
  // Publishing is the last moment this is repairable: a campaign version is
  // immutable, and every enrollment pinned to it inherits the mismatch.
  // Declaring a field the templates never name spends a turn on the operator's
  // subscription to write a sentence that appears in no email, and the review
  // card would announce it anyway. Naming a field nobody declared fails
  // interpolation at generation, one prospect at a time, with no way back.
  .superRefine((step, context) => {
    const used = new Set(
      reasoningVariablesUsed(step.subjectTemplate, step.bodyTemplate),
    );
    const declared = new Set(step.personalizationSchema?.fields ?? []);
    for (const field of declared) {
      if (!used.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["personalizationSchema"],
          message: `This step asks the agent for ${field}, but neither template uses {{${field}}}`,
        });
      }
    }
    for (const field of used) {
      if (!declared.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["bodyTemplate"],
          message: `This step uses {{${field}}}, but does not ask the agent to write it`,
        });
      }
    }
  });

export const campaignConfigurationSchema = z
  .object({
    automaticFollowUps: z.boolean().optional(),
    holdNonTerminalReplies: z.boolean().optional(),
    requireProfessionalRelevance: z.boolean().optional(),
    campaignDailyCap: z.number().int().positive().max(10_000).optional(),
  })
  .catchall(z.unknown())
  // `reviewMode` used to live here as a three-value enum that no decision path
  // ever read, next to a picker offering one value. Removing the field is not
  // enough: the catchall would then accept it in silence, and a POST could
  // still write `assisted` or `automatic` into a version nobody can edit
  // afterwards. Whether a first email may leave unread is an invariant this
  // build enforces, not a per-campaign setting, so the key is refused outright
  // and comes back only when it has two behaviours to choose between.
  .refine((configuration) => !("reviewMode" in configuration), {
    message:
      "reviewMode is not a campaign setting: no first send may be system-originated",
    path: ["reviewMode"],
  });

/**
 * The steps of one version.
 *
 * Any step may ask an agent for a sentence. Step zero is generated through the
 * operator-command queue on enrolment; every later step is queued the same way
 * by the follow-up path the moment it sees a declaration, rather than being
 * generated inline. Both therefore inherit the queue's bound of one AI turn per
 * pass, which is what makes the declaration safe to allow anywhere: the
 * followups stage loops over every due enrolment, and an agent call inside that
 * loop would spend the operator's single ChatGPT window once per prospect.
 */
const sequenceStepsSchema = z.array(sequenceStepSchema).min(1).max(20);

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(300),
  type: z.enum(["customer_discovery", "commercial_outreach", "other"]),
  targetDescription: z.string().trim().min(10).max(10_000),
  configuration: campaignConfigurationSchema,
  steps: sequenceStepsSchema,
});

export const publishCampaignSchema = z.object({
  campaignId: z.uuid(),
  campaignVersionId: z.uuid(),
});

export const reviseCampaignSchema = z.object({
  campaignId: z.uuid(),
  baseVersionId: z.uuid(),
  configuration: campaignConfigurationSchema,
  steps: sequenceStepsSchema,
});

export const enrollContactSchema = z.object({
  campaignId: z.uuid(),
  campaignVersionId: z.uuid(),
  contactId: z.uuid(),
  mailboxId: z.uuid().nullable().optional(),
});
