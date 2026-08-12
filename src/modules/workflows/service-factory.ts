import { eq } from "drizzle-orm";

import { enrollments, messages } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { requireOpenAIConfig } from "@/lib/openai/config";
import OpenAI from "openai";
import {
  OpenAIResponsesProvider,
  type ResponsesClient,
} from "@/lib/openai/providers/responses-provider";
import { createAgentSet } from "@/modules/agents/factory";
import {
  MockDnsMxResolver,
  NodeDnsMxResolver,
} from "@/modules/email-resolution/dns";
import { NoResultEmailEnrichmentProvider } from "@/modules/email-resolution/providers";
import {
  OpenAIPublicEmailEvidenceProvider,
  StaticPublicEmailEvidenceProvider,
} from "@/modules/email-resolution/public-evidence-provider";
import { resolveContactEmail } from "@/modules/email-resolution/service";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import {
  reconcileGraphDelta,
  reconcilePendingGraphLifecycleEvents,
  reconcilePendingGraphNotifications,
  runMicrosoftGraphMaintenance,
} from "@/modules/mailboxes/microsoft-graph-sync-service";
import { getMicrosoftAccessToken } from "@/modules/mailboxes/microsoft-oauth-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { OpenAIReplyClassifier } from "@/modules/agents/openai-agents";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { reconcilePendingInboundRecords } from "@/modules/replies/inbound-service";
import { discoverAccounts } from "@/modules/research/account-discovery-service";
import { researchAccount } from "@/modules/research/account-research-service";
import { discoverContacts } from "@/modules/research/contact-discovery-service";
import { personalizeReasoningFields } from "@/modules/research/personalization-service";
import type { WorkflowTaskServices } from "@/modules/workflows/runtime";
import {
  findDueEnrollments,
  processFollowUpInvocation,
} from "@/modules/workflows/follow-up-service";
import { findStaleRecoveryCandidates } from "@/modules/workflows/recovery-service";

function observedDate(value: string | undefined): Date {
  return value ? new Date(value) : new Date();
}

async function providerForEnrollment(
  enrollmentId: string,
  db: AppDatabase,
  environment: Record<string, string | undefined>,
) {
  const [enrollment] = await db
    .select({ mailboxId: enrollments.mailboxId })
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  return mailProvider(db, enrollment?.mailboxId ?? null, environment);
}

async function providerForMessage(
  messageId: string,
  db: AppDatabase,
  environment: Record<string, string | undefined>,
) {
  const [row] = await db
    .select({ mailboxId: messages.mailboxId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return mailProvider(db, row?.mailboxId ?? null, environment);
}

async function mailProvider(
  db: AppDatabase,
  mailboxId: string | null,
  environment: Record<string, string | undefined>,
) {
  return createMailProviderForMailbox(db, mailboxId, {
    microsoftConfig:
      environment.MAIL_PROVIDER === "microsoft_graph"
        ? requireMicrosoftConfig(environment)
        : undefined,
  });
}

function microsoftDependencies(
  environment: Record<string, string | undefined>,
  db: AppDatabase,
) {
  const config = requireMicrosoftConfig(environment);
  const graphForMailbox = (mailboxId: string) =>
    new MicrosoftGraphClient({
      accessToken: () => getMicrosoftAccessToken(db, config, mailboxId),
    });
  return { db, config, graphForMailbox };
}

export function createWorkflowTaskServices(
  db: AppDatabase,
  environment: Record<string, string | undefined> = process.env,
): WorkflowTaskServices {
  const agents = createAgentSet(environment);
  const openAIConfig =
    environment.OPENAI_PROVIDER === "openai"
      ? requireOpenAIConfig(environment)
      : null;
  const openAIProvider = openAIConfig
    ? new OpenAIResponsesProvider(
        new OpenAI({
          apiKey: openAIConfig.apiKey,
        }) as unknown as ResponsesClient,
      )
    : null;
  const classifier = openAIConfig
    ? new OpenAIReplyClassifier(openAIProvider!, openAIConfig.fastModel)
    : new DeterministicReplyClassifier();
  const runEmailResolution = (payload: {
    contactId: string;
    confidenceThreshold?: number;
  }) => {
    const openai = environment.OPENAI_PROVIDER === "openai";
    return resolveContactEmail(
      db,
      openai ? new NodeDnsMxResolver() : new MockDnsMxResolver(true),
      new NoResultEmailEnrichmentProvider(),
      payload,
      {
        publicEvidenceProvider: openai
          ? new OpenAIPublicEmailEvidenceProvider(
              openAIProvider!,
              openAIConfig!.researchModel,
            )
          : new StaticPublicEmailEvidenceProvider([]),
      },
    );
  };
  return {
    "account-discovery": (payload) =>
      discoverAccounts(db, agents.accountDiscovery, payload),
    "account-research": (payload) =>
      researchAccount(db, agents.accountResearch, payload),
    "contact-discovery": (payload) =>
      discoverContacts(db, agents.contactDiscovery, payload),
    "email-resolution": runEmailResolution,
    "personalize-message": (payload) =>
      personalizeReasoningFields(db, agents.personalization, payload),
    "generate-message": (payload) => generateOutreachProposal(db, payload),
    "send-approved-message": async (payload) =>
      sendApprovedMessage(
        db,
        await providerForMessage(payload.messageId, db, environment),
        payload,
      ),
    "advance-sequence": async (payload) =>
      processFollowUpInvocation(
        db,
        await providerForEnrollment(payload.enrollmentId, db, environment),
        payload,
      ),
    "reconcile-due-follow-ups": async (payload) => {
      const due = await findDueEnrollments(db, {
        now: observedDate(payload.observedAt),
        limit: payload.limit,
      });
      const results = [];
      for (const item of due) {
        results.push(
          await processFollowUpInvocation(
            db,
            await providerForEnrollment(item.enrollmentId, db, environment),
            item,
            { now: observedDate(payload.observedAt) },
          ),
        );
      }
      return results;
    },
    "drain-graph-webhooks": async (payload) => {
      if (environment.MAIL_PROVIDER !== "microsoft_graph") {
        return { skipped: true, reason: "microsoft_graph_disabled" };
      }
      const { config, graphForMailbox } = microsoftDependencies(
        environment,
        db,
      );
      const notifications = await reconcilePendingGraphNotifications(
        db,
        graphForMailbox,
        classifier,
        { now: observedDate(payload.observedAt), limit: payload.limit },
      );
      const lifecycle = await reconcilePendingGraphLifecycleEvents(
        db,
        graphForMailbox,
        classifier,
        config,
        {
          notificationUrl: environment.MICROSOFT_GRAPH_NOTIFICATION_URL,
          now: observedDate(payload.observedAt),
          limit: payload.limit,
        },
      );
      return { notifications, lifecycle };
    },
    "reconcile-graph-delta": async (payload) => {
      if (environment.MAIL_PROVIDER !== "microsoft_graph") {
        return { skipped: true, reason: "microsoft_graph_disabled" };
      }
      const { graphForMailbox } = microsoftDependencies(environment, db);
      return reconcileGraphDelta(
        db,
        graphForMailbox(payload.mailboxId),
        classifier,
        payload.mailboxId,
      );
    },
    "maintain-graph-subscriptions": async (payload) => {
      if (environment.MAIL_PROVIDER !== "microsoft_graph") {
        return { skipped: true, reason: "microsoft_graph_disabled" };
      }
      const notificationUrl = environment.MICROSOFT_GRAPH_NOTIFICATION_URL;
      if (!notificationUrl) {
        throw new Error("Microsoft notification URL is not configured");
      }
      const { config, graphForMailbox } = microsoftDependencies(
        environment,
        db,
      );
      return runMicrosoftGraphMaintenance(
        db,
        graphForMailbox,
        classifier,
        config,
        {
          notificationUrl,
          now: observedDate(payload.observedAt),
        },
      );
    },
    "recover-stale-work": async (payload) => {
      const now = observedDate(payload.observedAt);
      // This task spans several independent provider classes. Keep each class
      // intentionally tiny so one scheduled run stays within maxDuration and
      // every class makes progress on every tick.
      const recoveryLimit = Math.min(payload.limit ?? 1, 1);
      const candidates = await findStaleRecoveryCandidates(db, {
        now,
        limit: recoveryLimit,
        messageLimit: 2,
      });
      const inbound = await reconcilePendingInboundRecords(db, classifier, {
        now,
        limit: recoveryLimit,
      });
      const due = await findDueEnrollments(db, { now, limit: recoveryLimit });
      const messagesRecovered = [];
      for (const messageId of candidates.messageIds) {
        messagesRecovered.push(
          await sendApprovedMessage(
            db,
            await providerForMessage(messageId, db, environment),
            { messageId },
            { clock: () => now },
          ),
        );
      }
      const researchRecovered = [];
      for (const accountId of candidates.accountIds) {
        researchRecovered.push(
          await researchAccount(db, agents.accountResearch, {
            accountId,
            now,
          }),
        );
      }
      const resolutionsRecovered = [];
      for (const contactId of candidates.contactIds) {
        resolutionsRecovered.push(await runEmailResolution({ contactId }));
      }
      const followUpsRecovered = [];
      for (const item of due) {
        followUpsRecovered.push(
          await processFollowUpInvocation(
            db,
            await providerForEnrollment(item.enrollmentId, db, environment),
            item,
            { now },
          ),
        );
      }
      return {
        inbound,
        messagesRecovered,
        researchRecovered,
        resolutionsRecovered,
        followUpsRecovered,
      };
    },
  };
}
