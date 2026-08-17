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
import {
  interpolateStrict,
  type InterpolationError,
} from "@/modules/messages/interpolation";

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
      /**
       * Says out loud that this enrolment is now holding a question for a
       * human, for the enrolments no other path says it for.
       *
       * `reviewMessage` only accepts an answer from a `ready_for_review`
       * enrolment, and the follow-up lane states that itself: it promotes
       * `waiting` the moment it claims, before the message is even written. So
       * the two states that lane claims — `waiting` and `approved` — are left
       * alone here; they are on their way to the same place and moving them
       * early would take the step out of the lane's hands.
       *
       * The states the lane cannot claim had nobody to say it for them.
       * `manual_review` is the ordinary one: a soft bounce, a definite SMTP
       * recipient refusal, or a held non-terminal reply all park an enrolment
       * there with no `next_action_at`, and the prospect page offers
       * "Generate step N" on exactly those. The message was written, the
       * review card rendered its Approve button, and the click answered
       * "Enrollment is not awaiting message review" — with no way out but
       * Stop, which discards the sequence.
       *
       * Terminal enrolments never reach this: the guard above refuses them.
       */
      const awaitReview = async (fromState: string, messageId: string) => {
        if (
          fromState === "waiting" ||
          fromState === "approved" ||
          fromState === "ready_for_review"
        ) {
          return;
        }
        await tx
          .update(enrollments)
          .set({ state: "ready_for_review" })
          .where(eq(enrollments.id, parsed.data.enrollmentId));
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: parsed.data.enrollmentId,
          fromState,
          toState: "ready_for_review",
          reason: "generated_message_awaiting_review",
          metadata: { stepIndex: parsed.data.stepIndex, messageId },
        });
      };

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
        // Asking again for a message that is already there writes nothing —
        // but it is also exactly what an operator does when the Approve button
        // refused them, so the pair this rule exists to unstick is repaired
        // here too. Only for a proposal: a message already approved or gone is
        // not a question anybody is still holding.
        if (enrollmentGuard && existing.status === "proposed") {
          await awaitReview(enrollmentGuard.state, existing.id);
        }
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
        // Name the variable and why it could not be filled. Generation is no
        // longer a click the operator watches: it happens on enrolment and
        // this sentence is all that reaches `/outbound`. "Template variables
        // could not be resolved" cannot be acted on — the most reachable case
        // is a prospect saved without a job title against the default template
        // that names `{{job_title}}`, and knowing that is the difference
        // between filling one field and reading the code.
        const failure = (
          typeof subject === "string" ? body : subject
        ) as InterpolationError;
        const where = typeof subject === "string" ? "body" : "subject line";
        return {
          ok: false,
          code: "TEMPLATE_ERROR",
          message:
            failure.code === "MALFORMED_TEMPLATE"
              ? `The ${where} template is malformed`
              : failure.code === "UNKNOWN_VARIABLE"
                ? `The ${where} uses {{${failure.variable}}}, which is not a variable this campaign can fill`
                : `The ${where} uses {{${failure.variable}}}, and this prospect has no value for it`,
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
      if (enrollmentGuard) await awaitReview(enrollmentGuard.state, message.id);
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
