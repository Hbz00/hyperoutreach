import { sql } from "drizzle-orm";

import type { AppDatabase } from "@/lib/db/types";
import { AUTOMATIC_FOLLOW_UP_ACTOR } from "@/modules/workflows/follow-up-policy";

export type EditFreeStreak = {
  campaignId: string;
  campaignName: string;
  version: number;
  /** Consecutive most-recent approvals where the operator changed nothing. */
  streak: number;
  /** Every approval ever recorded for the version, for context. */
  total: number;
};

/**
 * How many messages in a row the operator approved without rewriting a word,
 * per immutable campaign version.
 *
 * This is the only automatability signal the product has a substrate for.
 * Message text is a template with four substituted fields, so there is nothing
 * per-message to score — but every approval already records whether the
 * operator edited it, and a long unbroken run is real evidence that review has
 * stopped changing the outcome. A single rewrite restarts the count, because
 * it is evidence of the opposite.
 *
 * Scoped to a version rather than a campaign: editing the template publishes a
 * new version, and a streak earned by older wording says nothing about the new
 * one.
 */
export async function readEditFreeStreaks(
  db: AppDatabase,
): Promise<EditFreeStreak[]> {
  const rows = await db.execute<{
    campaign_id: string;
    campaign_name: string;
    version: number;
    streak: number;
    total: number;
  }>(sql`
    with approvals as (
      select
        enrollments.campaign_version_id as version_id,
        workflow_events.created_at as created_at,
        coalesce((workflow_events.payload ->> 'edited')::boolean, false) as edited
      from workflow_events
      join messages on messages.id = workflow_events.entity_id
      join enrollments on enrollments.id = messages.enrollment_id
      where workflow_events.event = 'message.approved'
        -- Human approvals only. An automatic follow-up approves its own
        -- message through the same path, always unedited, so a campaign with
        -- automatic follow-ups on would otherwise grow an unbroken streak out
        -- of approvals nobody read — and this counter is the evidence meant
        -- to justify, one day, letting a first email go unread.
        and coalesce(workflow_events.payload ->> 'actor', '')
              <> ${AUTOMATIC_FOLLOW_UP_ACTOR}
    ),
    last_rewrite as (
      select version_id, max(created_at) as at
      from approvals
      where edited
      group by version_id
    )
    select
      campaign_versions.campaign_id as campaign_id,
      campaigns.name as campaign_name,
      campaign_versions.version as version,
      count(*) filter (
        where approvals.created_at > coalesce(last_rewrite.at, '-infinity'::timestamptz)
      )::int as streak,
      count(*)::int as total
    from approvals
    join campaign_versions on campaign_versions.id = approvals.version_id
    join campaigns on campaigns.id = campaign_versions.campaign_id
    left join last_rewrite on last_rewrite.version_id = approvals.version_id
    group by
      campaign_versions.campaign_id,
      campaigns.name,
      campaign_versions.version
    order by streak desc, campaigns.name asc
  `);
  return [...rows].map((row) => ({
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    version: row.version,
    streak: row.streak,
    total: row.total,
  }));
}
