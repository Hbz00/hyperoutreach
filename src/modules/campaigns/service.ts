import { and, desc, eq, sql } from "drizzle-orm";

import {
  campaigns,
  campaignVersions,
  contacts,
  enrollments,
  mailboxConnections,
  sequenceSteps,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  createCampaignSchema,
  enrollContactSchema,
  publishCampaignSchema,
  reviseCampaignSchema,
} from "@/modules/campaigns/input";

type Campaign = typeof campaigns.$inferSelect;
type CampaignVersion = typeof campaignVersions.$inferSelect;
type SequenceStep = typeof sequenceSteps.$inferSelect;
type Enrollment = typeof enrollments.$inferSelect;

type CampaignError =
  | { ok: false; code: "INVALID_INPUT"; message: "Invalid campaign input" }
  | { ok: false; code: "NOT_FOUND"; message: "Campaign resource not found" }
  | {
      ok: false;
      code: "VERSION_NOT_PUBLISHED";
      message: "Campaign version is not published";
    }
  | { ok: false; code: "DATABASE_ERROR"; message: "Could not save campaign" };

function invalidInput(): CampaignError {
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: "Invalid campaign input",
  };
}

function databaseError(): CampaignError {
  return {
    ok: false,
    code: "DATABASE_ERROR",
    message: "Could not save campaign",
  };
}

export async function createDraftCampaign(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | {
      ok: true;
      campaign: Campaign;
      version: CampaignVersion;
      steps: SequenceStep[];
    }
  | CampaignError
> {
  const parsed = createCampaignSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput();
  const input = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(campaigns)
        .values({
          name: input.name,
          type: input.type,
          targetDescription: input.targetDescription,
          status: "draft",
        })
        .returning();
      if (!campaign) throw new Error("Campaign insert returned no row");
      const [version] = await tx
        .insert(campaignVersions)
        .values({
          campaignId: campaign.id,
          version: 1,
          configuration: input.configuration,
        })
        .returning();
      if (!version) throw new Error("Campaign version insert returned no row");
      const steps = await tx
        .insert(sequenceSteps)
        .values(
          input.steps.map((step, stepIndex) => ({
            campaignVersionId: version.id,
            stepIndex,
            ...step,
          })),
        )
        .returning();
      return { ok: true, campaign, version, steps } as const;
    });
  } catch {
    return databaseError();
  }
}

export async function publishCampaignVersion(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | {
      ok: true;
      disposition: "published" | "already_published";
      version: CampaignVersion;
    }
  | CampaignError
> {
  const parsed = publishCampaignSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput();
  const input = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from campaign_versions where id = ${input.campaignVersionId} for update`,
      );
      const [version] = await tx
        .select()
        .from(campaignVersions)
        .where(
          and(
            eq(campaignVersions.id, input.campaignVersionId),
            eq(campaignVersions.campaignId, input.campaignId),
          ),
        )
        .limit(1);
      if (!version) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Campaign resource not found",
        } as const;
      }
      if (version.publishedAt) {
        return { ok: true, disposition: "already_published", version } as const;
      }
      const [published] = await tx
        .update(campaignVersions)
        .set({ publishedAt: new Date() })
        .where(eq(campaignVersions.id, version.id))
        .returning();
      if (!published) throw new Error("Campaign publication returned no row");
      await tx
        .update(campaigns)
        .set({ status: "active" })
        .where(eq(campaigns.id, input.campaignId));
      return {
        ok: true,
        disposition: "published",
        version: published,
      } as const;
    });
  } catch {
    return databaseError();
  }
}

export async function reviseCampaignVersion(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | {
      ok: true;
      disposition: "updated_draft" | "created_next_version";
      version: CampaignVersion;
      steps: SequenceStep[];
    }
  | CampaignError
> {
  const parsed = reviseCampaignSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput();
  const input = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from campaigns where id = ${input.campaignId} for update`,
      );
      const [base] = await tx
        .select()
        .from(campaignVersions)
        .where(
          and(
            eq(campaignVersions.id, input.baseVersionId),
            eq(campaignVersions.campaignId, input.campaignId),
          ),
        )
        .limit(1);
      if (!base) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Campaign resource not found",
        } as const;
      }

      if (!base.publishedAt && !base.usedAt) {
        const [updated] = await tx
          .update(campaignVersions)
          .set({ configuration: input.configuration })
          .where(eq(campaignVersions.id, base.id))
          .returning();
        if (!updated) throw new Error("Draft update returned no row");
        await tx
          .delete(sequenceSteps)
          .where(eq(sequenceSteps.campaignVersionId, base.id));
        const steps = await tx
          .insert(sequenceSteps)
          .values(
            input.steps.map((step, stepIndex) => ({
              campaignVersionId: base.id,
              stepIndex,
              ...step,
            })),
          )
          .returning();
        return {
          ok: true,
          disposition: "updated_draft",
          version: updated,
          steps,
        } as const;
      }

      const [latest] = await tx
        .select({ version: campaignVersions.version })
        .from(campaignVersions)
        .where(eq(campaignVersions.campaignId, input.campaignId))
        .orderBy(desc(campaignVersions.version))
        .limit(1);
      const [version] = await tx
        .insert(campaignVersions)
        .values({
          campaignId: input.campaignId,
          version: (latest?.version ?? 0) + 1,
          configuration: input.configuration,
        })
        .returning();
      if (!version) throw new Error("Next campaign version returned no row");
      const steps = await tx
        .insert(sequenceSteps)
        .values(
          input.steps.map((step, stepIndex) => ({
            campaignVersionId: version.id,
            stepIndex,
            ...step,
          })),
        )
        .returning();
      return {
        ok: true,
        disposition: "created_next_version",
        version,
        steps,
      } as const;
    });
  } catch {
    return databaseError();
  }
}

export async function enrollContact(
  db: AppDatabase,
  rawInput: unknown,
): Promise<
  | {
      ok: true;
      disposition: "created" | "existing";
      enrollment: Enrollment;
    }
  | CampaignError
> {
  const parsed = enrollContactSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput();
  const input = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(campaignVersions)
        .where(
          and(
            eq(campaignVersions.id, input.campaignVersionId),
            eq(campaignVersions.campaignId, input.campaignId),
          ),
        )
        .limit(1);
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, input.contactId))
        .limit(1);
      const mailbox = input.mailboxId
        ? await tx
            .select({ id: mailboxConnections.id })
            .from(mailboxConnections)
            .where(eq(mailboxConnections.id, input.mailboxId))
            .limit(1)
        : [null];
      if (!version || !contact || (input.mailboxId && !mailbox[0])) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "Campaign resource not found",
        } as const;
      }
      if (!version.publishedAt) {
        return {
          ok: false,
          code: "VERSION_NOT_PUBLISHED",
          message: "Campaign version is not published",
        } as const;
      }

      const [created] = await tx
        .insert(enrollments)
        .values({
          campaignId: input.campaignId,
          campaignVersionId: input.campaignVersionId,
          contactId: input.contactId,
          mailboxId: input.mailboxId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: created.id,
          fromState: null,
          toState: created.state,
          reason: "contact_enrolled",
          actor: "operator",
        });
        await tx.insert(workflowEvents).values({
          entityType: "enrollment",
          entityId: created.id,
          event: "enrollment.created",
          workflowName: "campaign_enrollment",
          idempotencyKey: `enrollment:${created.id}:created`,
          status: "succeeded",
          completedAt: new Date(),
        });
        return {
          ok: true,
          disposition: "created",
          enrollment: created,
        } as const;
      }

      const [existing] = await tx
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.campaignId, input.campaignId),
            eq(enrollments.contactId, input.contactId),
          ),
        )
        .limit(1);
      if (!existing)
        throw new Error("Enrollment conflict could not be reconciled");
      return {
        ok: true,
        disposition: "existing",
        enrollment: existing,
      } as const;
    });
  } catch {
    return databaseError();
  }
}
