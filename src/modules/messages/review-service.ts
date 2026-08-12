import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  enrollments,
  messages,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import {
  evaluateReviewTransition,
  type ReviewAction,
} from "@/modules/messages/review-policy";

const reviewInputSchema = z.object({
  messageId: z.uuid(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("approve") }),
    z.object({
      kind: z.literal("edit_and_approve"),
      subject: z.string(),
      body: z.string(),
    }),
    z.object({ kind: z.literal("reject"), reason: z.string() }),
  ]),
  actor: z.string().trim().min(1).max(200),
  workflowClaimId: z.uuid().optional(),
});

type Message = typeof messages.$inferSelect;

export type ReviewMessageResult =
  | { ok: true; message: Message }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "INVALID_TRANSITION"
        | "REPLY_PENDING"
        | "IN_PROGRESS"
        | "ENROLLMENT_TERMINAL"
        | "DATABASE_ERROR";
      message: string;
    };

export async function reviewMessage(
  db: AppDatabase,
  rawInput: unknown,
): Promise<ReviewMessageResult> {
  const parsed = reviewInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid review input",
    };
  }
  const input = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from messages where id = ${input.messageId} for update`,
      );
      const [message] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .limit(1);
      if (!message) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Message not found",
        } as const;
      }
      await tx.execute(
        sql`select id from enrollments where id = ${message.enrollmentId} for update`,
      );
      const [previousEnrollment] = await tx
        .select({
          state: enrollments.state,
          inboundHoldCount: enrollments.inboundHoldCount,
          workflowClaimId: enrollments.workflowClaimId,
        })
        .from(enrollments)
        .where(eq(enrollments.id, message.enrollmentId))
        .limit(1);
      if (
        previousEnrollment &&
        isTerminalEnrollmentState(previousEnrollment.state)
      ) {
        return {
          ok: false,
          code: "ENROLLMENT_TERMINAL",
          message: "Enrollment is already terminal",
        } as const;
      }
      if (previousEnrollment?.inboundHoldCount) {
        return {
          ok: false,
          code: "REPLY_PENDING",
          message: "A reply is pending classification",
        } as const;
      }
      if (
        input.workflowClaimId &&
        previousEnrollment?.workflowClaimId !== input.workflowClaimId
      ) {
        return {
          ok: false,
          code: "IN_PROGRESS",
          message: "The follow-up lease is owned by another invocation",
        } as const;
      }
      if (previousEnrollment?.state !== "ready_for_review") {
        return {
          ok: false,
          code: "INVALID_TRANSITION",
          message: "Enrollment is not awaiting message review",
        } as const;
      }
      if (message.status !== "proposed") {
        return {
          ok: false,
          code: "INVALID_TRANSITION",
          message: "Message cannot be reviewed from its current state",
        } as const;
      }

      const transition = evaluateReviewTransition(
        { status: "proposed", subject: message.subject, body: message.body },
        input.action as ReviewAction,
      );
      if (!transition.ok) {
        return {
          ok: false,
          code:
            transition.code === "INVALID_CONTENT"
              ? "INVALID_INPUT"
              : "INVALID_TRANSITION",
          message:
            transition.code === "INVALID_CONTENT"
              ? "Invalid review input"
              : "Message cannot be reviewed from its current state",
        } as const;
      }

      const now = new Date();
      const [updated] = await tx
        .update(messages)
        .set({
          status: transition.status,
          subject: transition.subject,
          body: transition.body,
          approvedAt: transition.status === "approved" ? now : null,
        })
        .where(eq(messages.id, message.id))
        .returning();
      if (!updated) throw new Error("Message review returned no row");

      const enrollmentUpdate =
        transition.status === "approved"
          ? { state: "approved" as const, approvedAt: now }
          : {
              state: "stopped" as const,
              stopReason: "manual_stop" as const,
              stoppedAt: now,
              nextActionAt: null,
              nextActionToken: null,
              inboundHoldCount: 0,
              inboundHoldAt: null,
              inboundHoldPreviousState: null,
              inboundHoldPreviousNextActionAt: null,
              inboundHoldPreviousNextActionToken: null,
              workflowClaimId: null,
              workflowClaimedAt: null,
            };
      await tx
        .update(enrollments)
        .set(enrollmentUpdate)
        .where(eq(enrollments.id, message.enrollmentId));

      await tx.insert(stateTransitions).values([
        {
          entityType: "message",
          entityId: message.id,
          fromState: message.status,
          toState: transition.status,
          reason:
            transition.status === "approved"
              ? "operator_approved"
              : transition.reason,
          actor: input.actor,
          metadata:
            input.action.kind === "edit_and_approve"
              ? { contentEdited: true }
              : {},
        },
        {
          entityType: "enrollment",
          entityId: message.enrollmentId,
          fromState: previousEnrollment?.state ?? null,
          toState: enrollmentUpdate.state,
          reason:
            transition.status === "approved"
              ? "message_approved"
              : transition.reason,
          actor: input.actor,
        },
      ]);
      const event =
        transition.status === "approved"
          ? "message.approved"
          : "message.rejected";
      await tx.insert(workflowEvents).values({
        entityType: "message",
        entityId: message.id,
        event,
        workflowName: "human_review",
        idempotencyKey: `review:${message.id}:${transition.status}`,
        status: "succeeded",
        completedAt: now,
        payload: {
          actor: input.actor,
          edited: input.action.kind === "edit_and_approve",
          reason: transition.reason,
          originalSubject: message.subject,
          originalBody: message.body,
          approvedSubject: transition.subject,
          approvedBody: transition.body,
        },
      });
      return { ok: true, message: updated } as const;
    });
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not review message",
    };
  }
}
