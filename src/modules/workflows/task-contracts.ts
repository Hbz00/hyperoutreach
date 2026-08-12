import { z } from "zod";

import {
  accountDiscoveryInputSchema,
  personalizationInputSchema,
} from "@/modules/agents/schemas";

export const WORKFLOW_TASKS = {
  "account-discovery": {
    maxDuration: 300,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "account-research": {
    maxDuration: 300,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "contact-discovery": {
    maxDuration: 300,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "email-resolution": {
    maxDuration: 180,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "personalize-message": {
    maxDuration: 180,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "generate-message": {
    maxDuration: 60,
    retry: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000 },
  },
  "send-approved-message": {
    maxDuration: 180,
    retry: { maxAttempts: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000 },
  },
  "advance-sequence": {
    maxDuration: 180,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "reconcile-due-follow-ups": {
    maxDuration: 180,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
  "drain-graph-webhooks": {
    maxDuration: 300,
    retry: { maxAttempts: 4, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
  },
  "reconcile-graph-delta": {
    maxDuration: 300,
    retry: { maxAttempts: 4, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 },
  },
  "maintain-graph-subscriptions": {
    maxDuration: 300,
    retry: { maxAttempts: 4, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000 },
  },
  "recover-stale-work": {
    maxDuration: 300,
    retry: { maxAttempts: 3, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000 },
  },
} as const;

export type WorkflowTaskName = keyof typeof WORKFLOW_TASKS;

export const workflowTaskNames = Object.keys(
  WORKFLOW_TASKS,
) as WorkflowTaskName[];

export type WorkflowPayloads = {
  "account-discovery": {
    icp: string;
    limit: number;
    countries?: string[];
    industries?: string[];
    requiredSignals?: string[];
  };
  "account-research": { accountId: string; force?: boolean };
  "contact-discovery": { accountId: string; roles: string[]; limit: number };
  "email-resolution": { contactId: string; confidenceThreshold?: number };
  "personalize-message": {
    declaredFields: Array<"company_relevance" | "personalized_opening">;
    trustedSourceUrls: string[];
    context: {
      company: string;
      firstName: string;
      jobTitle: string;
      research: Record<string, unknown>;
    };
  };
  "generate-message": {
    enrollmentId: string;
    stepIndex: number;
    recipient: string;
  };
  "send-approved-message": { messageId: string };
  "advance-sequence": {
    enrollmentId: string;
    expectedStep: number;
    expectedVersionId: string;
    expectedDueAt: string;
    expectedToken: string;
  };
  "reconcile-due-follow-ups": { observedAt?: string; limit?: number };
  "drain-graph-webhooks": { observedAt?: string; limit?: number };
  "reconcile-graph-delta": { mailboxId: string };
  "maintain-graph-subscriptions": { observedAt?: string };
  "recover-stale-work": { observedAt?: string; limit?: number };
};

export type WorkflowDispatchRequest<T extends WorkflowTaskName> = {
  task: T;
  payload: WorkflowPayloads[T];
  idempotencyKey: string;
};

const observedAtSchema = z.iso.datetime({ offset: true }).optional();

export const WORKFLOW_PAYLOAD_SCHEMAS = {
  "account-discovery": accountDiscoveryInputSchema,
  "account-research": z
    .object({ accountId: z.uuid(), force: z.boolean().optional() })
    .strict(),
  "contact-discovery": z
    .object({
      accountId: z.uuid(),
      roles: z.array(z.string().trim().min(2).max(300)).min(1).max(50),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  "email-resolution": z
    .object({
      contactId: z.uuid(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .strict(),
  "personalize-message": personalizationInputSchema,
  "generate-message": z
    .object({
      enrollmentId: z.uuid(),
      stepIndex: z.number().int().min(0),
      recipient: z.email(),
    })
    .strict(),
  "send-approved-message": z.object({ messageId: z.uuid() }).strict(),
  "advance-sequence": z
    .object({
      enrollmentId: z.uuid(),
      expectedStep: z.number().int().min(0),
      expectedVersionId: z.uuid(),
      expectedDueAt: z.iso.datetime({ offset: true }),
      expectedToken: z.string().trim().min(1).max(200),
    })
    .strict(),
  "reconcile-due-follow-ups": z
    .object({
      observedAt: observedAtSchema,
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  "drain-graph-webhooks": z
    .object({
      observedAt: observedAtSchema,
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  "reconcile-graph-delta": z.object({ mailboxId: z.uuid() }).strict(),
  "maintain-graph-subscriptions": z
    .object({ observedAt: observedAtSchema })
    .strict(),
  "recover-stale-work": z
    .object({
      observedAt: observedAtSchema,
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
} satisfies Record<WorkflowTaskName, z.ZodType>;

export function parseWorkflowPayload<T extends WorkflowTaskName>(
  task: T,
  payload: unknown,
): WorkflowPayloads[T] {
  return WORKFLOW_PAYLOAD_SCHEMAS[task].parse(payload) as WorkflowPayloads[T];
}
