import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  accounts,
  campaigns,
  campaignVersions,
  contacts,
  enrollments,
  mailboxConnections,
  messages,
  operatorCommands,
  operatorSendingSettings,
  sequenceSteps,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { interpolateStrict } from "@/modules/messages/interpolation";
import { stepDeclaresPersonalization } from "@/modules/messages/personalization-declaration";

const DAY_MS = 24 * 60 * 60_000;

export type SendBudget = {
  scope: "mailbox" | "campaign";
  name: string;
  used: number;
  cap: number;
};

export type DueFollowUp = {
  enrollmentId: string;
  contactName: string;
  accountName: string;
  campaignName: string;
  step: number;
  dueAt: Date;
  subject: string | null;
  body: string | null;
  note: string;
};

export type QueuedWork = {
  id: string;
  command: string;
  status: string;
  detail: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  requestedBy: string;
  createdAt: Date;
  retryable: boolean;
};

export type RecentSend = {
  messageId: string;
  recipient: string;
  subject: string;
  campaignName: string;
  sentAt: Date | null;
  attemptedAt: Date | null;
  status: string;
};

/**
 * What the sending policy has already spent, counted the way the policy counts
 * it.
 *
 * `evaluateStoredSendPolicy` charges a message against the daily cap when it
 * was sent **or** when a send was attempted, so a view that counted only
 * deliveries would promise capacity that is already gone — and the operator
 * would learn otherwise only by clicking Send and being refused.
 */
export async function readSendBudgets(
  db: AppDatabase,
  now: Date,
): Promise<SendBudget[]> {
  const [settings] = await db
    .select()
    .from(operatorSendingSettings)
    .where(eq(operatorSendingSettings.id, 1))
    .limit(1);
  if (!settings) return [];
  const since = new Date(now.getTime() - DAY_MS);
  const spent = and(
    eq(messages.direction, "outbound"),
    or(gte(messages.sentAt, since), gte(messages.sendAttemptedAt, since)),
  );

  const byMailbox = await db
    .select({
      name: mailboxConnections.email,
      used: sql<number>`count(${messages.id})::int`,
    })
    .from(mailboxConnections)
    .leftJoin(enrollments, eq(enrollments.mailboxId, mailboxConnections.id))
    .leftJoin(messages, and(eq(messages.enrollmentId, enrollments.id), spent))
    .groupBy(mailboxConnections.id, mailboxConnections.email)
    .orderBy(asc(mailboxConnections.email));

  // Grouped by campaign, not by campaign version. The policy charges the cap
  // per campaign across every version, and publishing a new version is routine
  // — turning on personalization does it. Grouping on the version would split
  // one campaign's spend into two half-counts, each announcing capacity the
  // policy has already spent.
  //
  // The cap, though, is read per version by the policy, and two live versions
  // can carry different overrides. There is no single true number, so this
  // takes the newest published version's — the one every send from now on is
  // measured against. `max()` over the overrides was the wrong choice: with an
  // older version set to 200 and the current one to 20, it announced 200 while
  // the policy refused at 20.
  const byCampaign = await db
    .select({
      name: campaigns.name,
      cap: sql<number | null>`(array_agg(
        (${campaignVersions.configuration} ->> 'campaignDailyCap')::int
        order by ${campaignVersions.version} desc
      ))[1]`,
      used: sql<number>`count(${messages.id})::int`,
    })
    .from(campaigns)
    .innerJoin(enrollments, eq(enrollments.campaignId, campaigns.id))
    .innerJoin(
      campaignVersions,
      eq(campaignVersions.id, enrollments.campaignVersionId),
    )
    .leftJoin(messages, and(eq(messages.enrollmentId, enrollments.id), spent))
    .where(eq(campaigns.status, "active"))
    .groupBy(campaigns.id, campaigns.name)
    .orderBy(asc(campaigns.name));

  return [
    ...byMailbox.map((row) => ({
      scope: "mailbox" as const,
      name: row.name,
      used: row.used,
      cap: settings.mailboxDailyCap,
    })),
    ...byCampaign.map((row) => ({
      scope: "campaign" as const,
      name: row.name,
      used: row.used,
      cap: row.cap ?? settings.campaignDailyCap,
    })),
  ];
}

/**
 * Follow-ups whose next step falls due within the window, with the text they
 * would carry.
 *
 * The text is a projection, not a promise. Interpolation resolves the
 * contact's name, title and company at generation time, so a prospect who
 * changes job before the step runs gets different words; and a step that asks
 * for an AI-written field cannot be previewed at all, because the sentence
 * does not exist until the agent writes it. Each row says which case it is
 * rather than presenting a guess as the message.
 */
export async function readDueFollowUps(
  db: AppDatabase,
  options: { now: Date; withinMs?: number },
): Promise<DueFollowUp[]> {
  const horizon = new Date(
    options.now.getTime() + (options.withinMs ?? DAY_MS),
  );
  const rows = await db
    .select({
      enrollmentId: enrollments.id,
      step: enrollments.currentStep,
      dueAt: enrollments.nextActionAt,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactFullName: contacts.fullName,
      jobTitle: contacts.jobTitle,
      accountName: accounts.name,
      campaignName: campaigns.name,
      subjectTemplate: sequenceSteps.subjectTemplate,
      bodyTemplate: sequenceSteps.bodyTemplate,
      personalizationSchema: sequenceSteps.personalizationSchema,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .innerJoin(
      sequenceSteps,
      and(
        eq(sequenceSteps.campaignVersionId, enrollments.campaignVersionId),
        eq(sequenceSteps.stepIndex, enrollments.currentStep),
      ),
    )
    .where(
      and(
        isNotNull(enrollments.nextActionAt),
        lte(enrollments.nextActionAt, horizon),
        inArray(enrollments.state, ["waiting", "approved", "active"]),
      ),
    )
    .orderBy(asc(enrollments.nextActionAt));

  return rows.map((row) => {
    // The tree's one answer to "does this step need an agent", rather than a
    // fourth private copy of the shape check. The copy this replaces also
    // dereferenced the column without a guard: `personalization_schema` is
    // `jsonb not null`, which does not exclude the JSON value `null`, and a
    // single such row would have taken the whole page down.
    if (stepDeclaresPersonalization(row.personalizationSchema)) {
      return {
        enrollmentId: row.enrollmentId,
        contactName: row.contactFullName,
        accountName: row.accountName,
        campaignName: row.campaignName,
        step: row.step + 1,
        dueAt: row.dueAt!,
        subject: null,
        body: null,
        note: "Personalized at generation — the sentence does not exist yet",
      };
    }
    const values = {
      first_name: row.contactFirstName,
      last_name: row.contactLastName,
      company: row.accountName,
      job_title: row.jobTitle,
    };
    const subject = interpolateStrict(row.subjectTemplate, values);
    const body = interpolateStrict(row.bodyTemplate, values);
    const resolved = typeof subject === "string" && typeof body === "string";
    return {
      enrollmentId: row.enrollmentId,
      contactName: row.contactFullName,
      accountName: row.accountName,
      campaignName: row.campaignName,
      step: row.step + 1,
      dueAt: row.dueAt!,
      subject: resolved ? (subject as string) : null,
      body: resolved ? (body as string) : null,
      note: resolved
        ? "Projected from the current template and prospect record"
        : "Cannot be projected — a template field has no value on this prospect",
    };
  });
}

/** What a parked command is actually waiting for, said in words. */
const WAITING_DETAIL: Record<string, string> = {
  awaiting_accepted_email: "Waiting for a resolved email address",
  awaiting_account_research: "Waiting for this company to be researched",
  awaiting_reply_classification: "Waiting for a reply to be classified",
};

/**
 * The sentence the service wrote, when it wrote one.
 *
 * A confidence refusal explains itself — "the agent was 0.42 confident, below
 * the 0.50 this step requires" — and that sentence lives in the recorded
 * result. Showing the bare code instead would tell the operator that something
 * stopped without telling them what to do about it.
 */
function commandDetail(row: typeof operatorCommands.$inferSelect): string {
  if (row.status === "waiting") {
    return (
      WAITING_DETAIL[row.waitingReason ?? ""] ?? row.waitingReason ?? "Waiting"
    );
  }
  const explained = (row.result as { message?: unknown } | null)?.message;
  if (typeof explained === "string" && explained.trim()) return explained;
  return row.error ?? "";
}

/** Operator work the maintenance cycle has not finished with. */
export async function readQueuedWork(
  db: AppDatabase,
  options: { limit?: number } = {},
): Promise<QueuedWork[]> {
  const rows = await db
    .select()
    .from(operatorCommands)
    .where(
      inArray(operatorCommands.status, [
        "queued",
        "waiting",
        "running",
        "abandoned",
      ]),
    )
    .orderBy(desc(operatorCommands.createdAt))
    .limit(options.limit ?? 50);
  return rows.map((row) => ({
    id: row.id,
    command: row.command,
    status: row.status,
    detail: commandDetail(row),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    retryable: row.status === "abandoned" || row.status === "waiting",
  }));
}

/** What has just left, so "nothing happened" is distinguishable from "it did". */
export type ScheduledSend = {
  messageId: string;
  recipient: string;
  subject: string;
  campaignName: string;
  scheduledAt: Date;
  expiresAt: Date | null;
};

/**
 * Sends the operator asked for that are waiting for a legal instant.
 *
 * This page is called "what goes out", and a message waiting for Monday
 * morning is the clearest example of something that is going out and is not
 * visible anywhere else. Without it the intent would be a state the system
 * holds and the operator cannot see — which is the failure the whole view
 * exists to close.
 */
export async function readScheduledSends(
  db: AppDatabase,
): Promise<ScheduledSend[]> {
  const rows = await db
    .select({
      messageId: messages.id,
      recipient: messages.recipient,
      subject: messages.subject,
      campaignName: campaigns.name,
      scheduledAt: messages.scheduledAt,
      expiresAt: messages.sendIntentExpiresAt,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .where(
      and(eq(messages.status, "approved"), isNotNull(messages.scheduledAt)),
    )
    .orderBy(asc(messages.scheduledAt))
    .limit(50);
  return rows.flatMap((row) =>
    row.scheduledAt
      ? [{ ...row, scheduledAt: row.scheduledAt, expiresAt: row.expiresAt }]
      : [],
  );
}

export async function readRecentSends(
  db: AppDatabase,
  options: { now: Date; withinMs?: number; limit?: number },
): Promise<RecentSend[]> {
  const since = new Date(options.now.getTime() - (options.withinMs ?? DAY_MS));
  const rows = await db
    .select({
      messageId: messages.id,
      recipient: messages.recipient,
      subject: messages.subject,
      campaignName: campaigns.name,
      sentAt: messages.sentAt,
      attemptedAt: messages.sendAttemptedAt,
      status: messages.status,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        or(gte(messages.sentAt, since), gte(messages.sendAttemptedAt, since)),
      ),
    )
    .orderBy(desc(messages.sendAttemptedAt), desc(messages.sentAt))
    .limit(options.limit ?? 25);
  return rows;
}
