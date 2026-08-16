import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  accounts,
  contacts,
  enrollments,
  messagePersonalizationFields,
  messages,
  sequenceSteps,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { normalizeEmail } from "@/modules/prospects/normalization";
import { interpolateStrict } from "@/modules/messages/interpolation";

/**
 * Sentences an agent already wrote and that provenance already validated. The
 * generator interpolates them like any other field; it never calls an agent
 * itself, because an agent turn must not be held inside the transaction that
 * writes the message.
 */
const resolvedPersonalizationSchema = z.object({
  agentRunId: z.uuid().nullable().optional(),
  fields: z
    .array(
      z.object({
        name: z.enum(["company_relevance", "personalized_opening"]),
        value: z.string().trim().min(1),
        confidence: z.number().min(0).max(1),
        sourceUrls: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(2),
});

const generationInputSchema = z.object({
  enrollmentId: z.uuid(),
  stepIndex: z.number().int().min(0),
  recipient: z.string().trim().min(1),
  workflowClaimId: z.uuid().optional(),
  personalization: resolvedPersonalizationSchema.optional(),
});

type Message = typeof messages.$inferSelect;

export type GenerateOutreachResult =
  | {
      ok: true;
      disposition: "created" | "existing";
      message: Message;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "IN_PROGRESS"
        | "ENROLLMENT_INACTIVE"
        | "REPLY_PENDING"
        | "TEMPLATE_ERROR"
        | "DATABASE_ERROR";
      message: string;
    };

export async function generateOutreachProposal(
  db: AppDatabase,
  rawInput: unknown,
): Promise<GenerateOutreachResult> {
  const parsed = generationInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid message input",
    };
  }
  let recipient: string;
  try {
    recipient = normalizeEmail(parsed.data.recipient);
  } catch {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid message input",
    };
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from enrollments where id = ${parsed.data.enrollmentId} for update`,
      );
      const [enrollmentGuard] = await tx
        .select({
          inboundHoldCount: enrollments.inboundHoldCount,
          workflowClaimId: enrollments.workflowClaimId,
          state: enrollments.state,
        })
        .from(enrollments)
        .where(eq(enrollments.id, parsed.data.enrollmentId))
        .limit(1);
      if (enrollmentGuard && enrollmentGuard.inboundHoldCount > 0) {
        return {
          ok: false,
          code: "REPLY_PENDING",
          message: "A reply is pending classification",
        } as const;
      }
      if (
        parsed.data.workflowClaimId &&
        enrollmentGuard?.workflowClaimId !== parsed.data.workflowClaimId
      ) {
        return {
          ok: false,
          code: "IN_PROGRESS",
          message: "The follow-up lease is owned by another invocation",
        } as const;
      }
      if (
        enrollmentGuard &&
        ["replied", "opted_out", "bounced", "stopped", "completed"].includes(
          enrollmentGuard.state,
        )
      ) {
        return {
          ok: false,
          code: "ENROLLMENT_INACTIVE",
          message: "Enrollment is no longer active",
        } as const;
      }
      const [existing] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.enrollmentId, parsed.data.enrollmentId),
            eq(messages.stepIndex, parsed.data.stepIndex),
            eq(messages.direction, "outbound"),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          ok: true,
          disposition: "existing",
          message: existing,
        } as const;
      }

      const [context] = await tx
        .select({
          enrollmentId: enrollments.id,
          mailboxId: enrollments.mailboxId,
          versionId: enrollments.campaignVersionId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          jobTitle: contacts.jobTitle,
          contactAccountId: contacts.accountId,
          employmentVersion: contacts.employmentVersion,
          company: accounts.name,
          subjectTemplate: sequenceSteps.subjectTemplate,
          bodyTemplate: sequenceSteps.bodyTemplate,
          inboundHoldCount: enrollments.inboundHoldCount,
        })
        .from(enrollments)
        .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
        .innerJoin(accounts, eq(accounts.id, contacts.accountId))
        .innerJoin(
          sequenceSteps,
          and(
            eq(sequenceSteps.campaignVersionId, enrollments.campaignVersionId),
            eq(sequenceSteps.stepIndex, parsed.data.stepIndex),
          ),
        )
        .where(eq(enrollments.id, parsed.data.enrollmentId))
        .limit(1);
      if (!context) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Enrollment step not found",
        } as const;
      }
      if (context.inboundHoldCount > 0) {
        return {
          ok: false,
          code: "REPLY_PENDING",
          message: "A reply is pending classification",
        } as const;
      }

      const personalization = parsed.data.personalization;
      const values = {
        first_name: context.firstName,
        last_name: context.lastName,
        company: context.company,
        job_title: context.jobTitle,
        ...Object.fromEntries(
          (personalization?.fields ?? []).map((field) => [
            field.name,
            field.value,
          ]),
        ),
      };
      const subject = interpolateStrict(context.subjectTemplate, values);
      const body = interpolateStrict(context.bodyTemplate, values);
      if (typeof subject !== "string" || typeof body !== "string") {
        return {
          ok: false,
          code: "TEMPLATE_ERROR",
          message: "Template variables could not be resolved",
        } as const;
      }

      const outreachId = `out_${randomUUID()}`;
      const [message] = await tx
        .insert(messages)
        .values({
          enrollmentId: context.enrollmentId,
          mailboxId: context.mailboxId,
          stepIndex: parsed.data.stepIndex,
          direction: "outbound",
          outreachId,
          subject,
          body,
          recipient,
          contactAccountId: context.contactAccountId,
          employmentVersion: context.employmentVersion,
          status: "proposed",
          headers: { "X-Outreach-ID": outreachId },
        })
        .returning();
      if (!message) throw new Error("Message insert returned no row");
      if (personalization) {
        await tx.insert(messagePersonalizationFields).values(
          personalization.fields.map((field) => ({
            messageId: message.id,
            name: field.name,
            value: field.value,
            confidence: field.confidence.toFixed(3),
            sourceUrls: field.sourceUrls,
            agentRunId: personalization.agentRunId ?? null,
          })),
        );
      }
      await tx.insert(stateTransitions).values({
        entityType: "message",
        entityId: message.id,
        fromState: null,
        toState: "proposed",
        reason: "deterministic_generation",
      });
      await tx.insert(workflowEvents).values({
        entityType: "message",
        entityId: message.id,
        event: "message.proposed",
        workflowName: "outreach_generation",
        idempotencyKey: `generate:${context.enrollmentId}:${parsed.data.stepIndex}`,
        status: "succeeded",
        completedAt: new Date(),
        payload: { outreachId },
      });
      return { ok: true, disposition: "created", message } as const;
    });
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not generate message",
    };
  }
}
