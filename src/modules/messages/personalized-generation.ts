import { and, eq, isNull } from "drizzle-orm";

import {
  accounts,
  campaignVersions,
  contacts,
  enrollments,
  evidenceSources,
  messages,
  sequenceSteps,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { PersonalizationAgent } from "@/modules/agents/contracts";
import { readPersonalizationDeclaration } from "@/modules/messages/personalization-declaration";
import {
  generateOutreachProposal,
  type GenerateOutreachResult,
} from "@/modules/messages/generation-service";
import { personalizeReasoningFields } from "@/modules/research/personalization-service";

export type PersonalizedGenerationResult =
  | GenerateOutreachResult
  | {
      ok: false;
      code:
        | "AWAITING_RESEARCH"
        | "LOW_CONFIDENCE"
        | "AGENT_ERROR"
        | "REPLY_PENDING";
      message: string;
    };

/**
 * Writes one message, asking an agent for the sentences the step declared.
 *
 * Three outcomes that are not the same thing, and the queue treats each
 * differently:
 *
 * - **Nothing to research yet.** The agent's input requires at least one
 *   trusted source URL, so an account without completed research can never
 *   satisfy it. That is a wait, not a failure: retrying produces no evidence.
 * - **The agent failed.** Transient, retried a bounded number of times.
 * - **The agent answered below the bar.** A message is not produced, and the
 *   operator is told the confidence rather than handed a weak sentence — the
 *   failure policy they chose.
 *
 * The agent turn happens before the write, never inside it: it is a turn on a
 * single shared window and can take seconds, which is not something to hold a
 * transaction open for.
 */
export async function generateWithPersonalization(
  db: AppDatabase,
  agent: PersonalizationAgent,
  input: {
    enrollmentId: string;
    stepIndex: number;
    recipient: string;
    workflowClaimId?: string;
  },
): Promise<PersonalizedGenerationResult> {
  const [context] = await db
    .select({
      declared: sequenceSteps.personalizationSchema,
      accountId: contacts.accountId,
      company: accounts.name,
      firstName: contacts.firstName,
      jobTitle: contacts.jobTitle,
      researchStatus: accounts.researchStatus,
      researchSnapshot: accounts.researchSnapshot,
      inboundHoldCount: enrollments.inboundHoldCount,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .innerJoin(
      campaignVersions,
      eq(campaignVersions.id, enrollments.campaignVersionId),
    )
    .innerJoin(
      sequenceSteps,
      and(
        eq(sequenceSteps.campaignVersionId, campaignVersions.id),
        eq(sequenceSteps.stepIndex, input.stepIndex),
      ),
    )
    .where(eq(enrollments.id, input.enrollmentId))
    .limit(1);

  const declared = context
    ? readPersonalizationDeclaration(context.declared)
    : null;
  if (!context || !declared) {
    return generateOutreachProposal(db, input);
  }

  // Already written. `generateOutreachProposal` answers `existing` for this,
  // but only from inside its write transaction — after the agent turn. The
  // manual "Generate step N" control on the prospect page carries a fresh
  // request token per render, so every click is a new command row: clicking it
  // on a step that already has a message spent a turn on the operator's window
  // to be told the message was there all along. The generator still owns the
  // rule under its row lock; this only declines to pay for the answer twice.
  const [already] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, input.enrollmentId),
        eq(messages.stepIndex, input.stepIndex),
        eq(messages.direction, "outbound"),
        // The same rule the generator applies under its row lock, and it has to
        // be the same one: a ladder advance frees the step precisely by marking
        // its message dead, and treating that row as "already written" here
        // skipped the agent turn the new message needs — leaving interpolation
        // to fail on a field nobody wrote, and the queue to abandon a command a
        // manual retry could never get past either.
        isNull(messages.addressDeadAt),
      ),
    )
    .limit(1);
  if (already) return generateOutreachProposal(db, input);

  // A held reply is the one waiting state that repeats. The queue parks
  // `REPLY_PENDING` and asks again every five minutes, which is right — but
  // the generator only reports it from inside its own write transaction, well
  // after the agent turn. Left alone, a prospect whose reply sits in manual
  // review would spend one turn on the operator's ChatGPT window every five
  // minutes, indefinitely, to be told to wait. The rule still belongs to
  // `generateOutreachProposal`, which re-reads it under a row lock; this only
  // declines to pay for the answer twice.
  if (context.inboundHoldCount > 0) {
    return {
      ok: false,
      code: "REPLY_PENDING",
      message: "A reply is pending classification",
    };
  }

  const sources = await db
    .select({ url: evidenceSources.url })
    .from(evidenceSources)
    .where(eq(evidenceSources.accountId, context.accountId));
  const trustedSourceUrls = [...new Set(sources.map((row) => row.url))];
  if (context.researchStatus !== "complete" || trustedSourceUrls.length === 0) {
    return {
      ok: false,
      code: "AWAITING_RESEARCH",
      message: "This company has no researched evidence to personalize from",
    };
  }

  // The agent's input requires a job title. A prospect without one would fail
  // schema validation with `INVALID_INPUT`, which reads as a bug rather than
  // as the missing field it is — and no retry can invent it.
  if (!context.jobTitle?.trim()) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "This prospect has no job title, and the agent needs one to personalize",
    };
  }

  const personalized = await personalizeReasoningFields(db, agent, {
    declaredFields: declared.fields,
    trustedSourceUrls,
    context: {
      company: context.company,
      firstName: context.firstName,
      jobTitle: context.jobTitle,
      research: context.researchSnapshot ?? {},
    },
  });
  if (!personalized.ok) return personalized;

  const weakest = personalized.personalization.fields.reduce(
    (lowest, field) => Math.min(lowest, field.confidence),
    1,
  );
  if (weakest < declared.minConfidence) {
    return {
      ok: false,
      code: "LOW_CONFIDENCE",
      message: `The agent was ${weakest.toFixed(2)} confident, below the ${declared.minConfidence.toFixed(2)} this step requires`,
    };
  }

  return generateOutreachProposal(db, {
    ...input,
    personalization: {
      agentRunId: personalized.agentRunId,
      fields: personalized.personalization.fields,
    },
  });
}
