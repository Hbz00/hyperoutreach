import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  campaigns,
  enrollments,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import type { AppDatabase } from "@/lib/db/types";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";

const stopSchema = z.object({
  enrollmentId: z.uuid(),
  actor: z.string().trim().min(1).max(200),
});
const pauseSchema = z.object({
  campaignId: z.uuid(),
  actor: z.string().trim().min(1).max(200),
});
const resumeSchema = pauseSchema;

export async function pauseCampaign(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "paused" | "already_paused" }
  | {
      ok: false;
      code: "INVALID_INPUT" | "NOT_FOUND" | "INVALID_STATE" | "DATABASE_ERROR";
    }
> {
  const parsed = pauseSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  try {
    return await withActionLocks(
      db,
      [actionLockKey.campaign(parsed.data.campaignId)],
      async (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(campaigns)
            .where(eq(campaigns.id, parsed.data.campaignId))
            .limit(1);
          if (!current) return { ok: false, code: "NOT_FOUND" } as const;
          if (current.status === "paused") {
            return { ok: true, disposition: "already_paused" } as const;
          }
          if (current.status !== "active") {
            return { ok: false, code: "INVALID_STATE" } as const;
          }
          await tx
            .update(campaigns)
            .set({ status: "paused" })
            .where(eq(campaigns.id, current.id));
          await tx.insert(stateTransitions).values({
            entityType: "campaign",
            entityId: current.id,
            fromState: current.status,
            toState: "paused",
            reason: "operator_paused",
            actor: parsed.data.actor,
          });
          return { ok: true, disposition: "paused" } as const;
        }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function stopEnrollment(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "stopped" | "already_terminal" }
  | { ok: false; code: "INVALID_INPUT" | "NOT_FOUND" | "DATABASE_ERROR" }
> {
  const parsed = stopSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  try {
    return await withActionLocks(
      db,
      [actionLockKey.enrollment(parsed.data.enrollmentId)],
      async (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          await tx.execute(
            sql`select id from enrollments where id = ${parsed.data.enrollmentId} for update`,
          );
          const [current] = await tx
            .select()
            .from(enrollments)
            .where(eq(enrollments.id, parsed.data.enrollmentId))
            .limit(1);
          if (!current) return { ok: false, code: "NOT_FOUND" } as const;
          if (isTerminalEnrollmentState(current.state)) {
            return { ok: true, disposition: "already_terminal" } as const;
          }
          const now = new Date();
          await tx
            .update(enrollments)
            .set({
              state: "stopped",
              stopReason: "manual_stop",
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
            })
            .where(eq(enrollments.id, current.id));
          await tx.insert(stateTransitions).values({
            entityType: "enrollment",
            entityId: current.id,
            fromState: current.state,
            toState: "stopped",
            reason: "manual_stop",
            actor: parsed.data.actor,
          });
          await tx.insert(workflowEvents).values({
            entityType: "enrollment",
            entityId: current.id,
            event: "enrollment.manual_stop",
            workflowName: "enrollment_lifecycle",
            idempotencyKey: `enrollment:${current.id}:manual_stop`,
            status: "cancelled",
            completedAt: now,
            payload: { actor: parsed.data.actor },
          });
          return { ok: true, disposition: "stopped" } as const;
        }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function resumeCampaign(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; disposition: "resumed" | "already_active" }
  | {
      ok: false;
      code: "INVALID_INPUT" | "NOT_FOUND" | "INVALID_STATE" | "DATABASE_ERROR";
    }
> {
  const parsed = resumeSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  try {
    return await withActionLocks(
      db,
      [actionLockKey.campaign(parsed.data.campaignId)],
      async (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(campaigns)
            .where(eq(campaigns.id, parsed.data.campaignId))
            .limit(1);
          if (!current) return { ok: false, code: "NOT_FOUND" } as const;
          if (current.status === "active") {
            return { ok: true, disposition: "already_active" } as const;
          }
          if (current.status !== "paused") {
            return { ok: false, code: "INVALID_STATE" } as const;
          }
          await tx
            .update(campaigns)
            .set({ status: "active" })
            .where(eq(campaigns.id, current.id));
          const now = new Date();
          await tx.insert(stateTransitions).values({
            entityType: "campaign",
            entityId: current.id,
            fromState: "paused",
            toState: "active",
            reason: "operator_resumed",
            actor: parsed.data.actor,
          });
          await tx.insert(workflowEvents).values({
            entityType: "campaign",
            entityId: current.id,
            event: "campaign.resumed",
            workflowName: "campaign_lifecycle",
            idempotencyKey: `campaign:${current.id}:resumed:${now.toISOString()}`,
            status: "succeeded",
            completedAt: now,
            payload: { actor: parsed.data.actor },
          });
          return { ok: true, disposition: "resumed" } as const;
        }),
    );
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}
