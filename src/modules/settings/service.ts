import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { operatorSendingSettings, stateTransitions } from "@/lib/db/schema";
import {
  actionLockKey,
  isActionLockBusy,
  withActionLocks,
} from "@/lib/db/action-lock";
import type { AppDatabase } from "@/lib/db/types";

const settingsId = 1;
const settingsEntityId = "00000000-0000-0000-0000-000000000001";

export const CONSERVATIVE_SENDING_DEFAULTS = {
  id: settingsId,
  emergencyPause: false,
  timezone: "Europe/Paris",
  workingDays: [1, 2, 3, 4, 5] as number[],
  workingStartMinute: 9 * 60,
  workingEndMinute: 18 * 60,
  mailboxDailyCap: 25,
  campaignDailyCap: 100,
  mailboxMinimumDelaySeconds: 60,
  contactMinimumDelayMinutes: 24 * 60,
  crossCampaignCooldownDays: 30,
} as const;

const updateSchema = z
  .object({
    emergencyPause: z.boolean().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    workingDays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length)
      .optional(),
    workingStartMinute: z.number().int().min(0).max(1_439).optional(),
    workingEndMinute: z.number().int().min(1).max(1_440).optional(),
    mailboxDailyCap: z.number().int().positive().max(10_000).optional(),
    campaignDailyCap: z.number().int().positive().max(100_000).optional(),
    mailboxMinimumDelaySeconds: z.number().int().min(0).max(86_400).optional(),
    contactMinimumDelayMinutes: z.number().int().min(0).max(525_600).optional(),
    crossCampaignCooldownDays: z.number().int().min(0).max(3_650).optional(),
    actor: z.string().trim().min(1).max(200),
  })
  .refine(
    (value) =>
      value.workingStartMinute === undefined ||
      value.workingEndMinute === undefined ||
      value.workingStartMinute < value.workingEndMinute,
    { message: "Working window must have a positive duration" },
  );

export type SendingSettings = typeof operatorSendingSettings.$inferSelect;

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export async function getOperatorSendingSettings(
  db: AppDatabase,
): Promise<SendingSettings> {
  await db
    .insert(operatorSendingSettings)
    .values(CONSERVATIVE_SENDING_DEFAULTS)
    .onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(operatorSendingSettings)
    .where(eq(operatorSendingSettings.id, settingsId))
    .limit(1);
  if (!settings) throw new Error("Operator settings singleton is missing");
  return settings;
}

export async function updateOperatorSendingSettings(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | { ok: true; settings: SendingSettings }
  | { ok: false; code: "INVALID_INPUT" | "IN_PROGRESS" | "DATABASE_ERROR" }
> {
  const parsed = updateSchema.safeParse(rawInput);
  if (
    !parsed.success ||
    (parsed.data.timezone && !validTimezone(parsed.data.timezone))
  ) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  const { actor, ...changes } = parsed.data;
  try {
    return await withActionLocks(
      db,
      [actionLockKey.settings()],
      async (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(operatorSendingSettings)
            .where(eq(operatorSendingSettings.id, settingsId))
            .limit(1);
          const merged = {
            ...CONSERVATIVE_SENDING_DEFAULTS,
            ...current,
            ...changes,
          };
          if (merged.workingStartMinute >= merged.workingEndMinute) {
            return { ok: false, code: "INVALID_INPUT" } as const;
          }
          const [settings] = await tx
            .insert(operatorSendingSettings)
            .values({ ...merged, id: settingsId, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: operatorSendingSettings.id,
              set: { ...changes, updatedAt: new Date() },
            })
            .returning();
          if (!settings) throw new Error("Settings update returned no row");
          await tx.insert(stateTransitions).values({
            entityType: "operator_sending_settings",
            entityId: settingsEntityId,
            fromState: current?.emergencyPause ? "emergency_paused" : "active",
            toState: settings.emergencyPause ? "emergency_paused" : "active",
            reason: "operator_settings_updated",
            actor,
            metadata: {
              updateId: randomUUID(),
              changedFields: Object.keys(changes),
            },
          });
          return { ok: true, settings } as const;
        }),
    );
  } catch (error) {
    if (isActionLockBusy(error)) return { ok: false, code: "IN_PROGRESS" };
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

/**
 * Re-exported so the send policy keeps importing it from here, while the rule
 * itself lives beside the "when does it next open" search that has to agree
 * with it to the minute.
 */
export { isWithinWorkingHours } from "@/modules/settings/working-hours";
