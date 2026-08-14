import { and, eq } from "drizzle-orm";

import { enrollments, mailboxConnections, messages } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import { createProductionAIProviderBundle } from "@/lib/openai/production-provider-bundle";
import type { AIProviderBundle } from "@/lib/openai/provider-bundle";
import { createAgentSetFromBundle } from "@/modules/agents/factory";
import {
  MockDnsMxResolver,
  NodeDnsMxResolver,
  type DnsMxResolver,
} from "@/modules/email-resolution/dns";
import { NoResultEmailEnrichmentProvider } from "@/modules/email-resolution/providers";
import {
  OpenAIPublicEmailEvidenceProvider,
  StaticPublicEmailEvidenceProvider,
  type PublicEmailEvidenceProvider,
} from "@/modules/email-resolution/public-evidence-provider";
import { resolveContactEmail } from "@/modules/email-resolution/service";
import {
  createCountingIngest,
  createInboundCursorWriter,
  reconcileInboundMailbox,
  withInboundReconciliationHealth,
} from "@/modules/mailboxes/inbound-reconciliation";
import "@/modules/mailboxes/inbound-source-bootstrap";
import { resolveInboundProvider } from "@/modules/mailboxes/inbound-source-registry";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import {
  reconcilePendingGraphLifecycleEvents,
  reconcilePendingGraphNotifications,
  runMicrosoftGraphMaintenance,
} from "@/modules/mailboxes/microsoft-graph-sync-service";
import { createMailboxGraphClient } from "@/modules/mailboxes/microsoft-oauth-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { createReplyClassifierFromBundle } from "@/modules/replies/classifier-factory";
import {
  ingestMatchedInboundMessage,
  reconcilePendingInboundRecords,
} from "@/modules/replies/inbound-service";
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
    environment,
  });
}

function microsoftDependencies(
  environment: Record<string, string | undefined>,
  db: AppDatabase,
) {
  const config = requireMicrosoftConfig(environment);
  const graphForMailbox = (mailboxId: string) =>
    createMailboxGraphClient(db, config, mailboxId);
  return { db, config, graphForMailbox };
}

export type WorkflowProviderDependencies = {
  createBundle(
    environment: Record<string, string | undefined>,
  ): AIProviderBundle;
  createRealDns(): DnsMxResolver;
  createMockDns(): DnsMxResolver;
};

const productionProviderDependencies: WorkflowProviderDependencies = {
  createBundle: createProductionAIProviderBundle,
  createRealDns: () => new NodeDnsMxResolver(),
  createMockDns: () => new MockDnsMxResolver(true),
};

type InboundBatchResult = {
  mailboxId: string;
  result?: unknown;
  error?: string;
};

export function assertInboundBatchSucceeded(
  results: InboundBatchResult[],
): void {
  if (results.some((result) => result.error !== undefined)) {
    throw new Error("Inbound mailbox reconciliation failed");
  }
}

export function composeEmailResolutionProviders(
  bundle: AIProviderBundle,
  dependencies: Pick<
    WorkflowProviderDependencies,
    "createRealDns" | "createMockDns"
  >,
): {
  dns: DnsMxResolver;
  publicEvidence: PublicEmailEvidenceProvider;
  publicEvidenceOperationTimeoutMs: number;
} {
  if (!bundle.usesRealInfrastructure) {
    return {
      dns: dependencies.createMockDns(),
      publicEvidence: new StaticPublicEmailEvidenceProvider([]),
      publicEvidenceOperationTimeoutMs: 10_000,
    };
  }
  return {
    dns: dependencies.createRealDns(),
    publicEvidence: new OpenAIPublicEmailEvidenceProvider(
      bundle.research.provider,
      bundle.research.model,
    ),
    publicEvidenceOperationTimeoutMs: bundle.research.operationTimeoutMs,
  };
}

export function createWorkflowTaskServices(
  db: AppDatabase,
  environment: Record<string, string | undefined> = process.env,
  providerDependencies: WorkflowProviderDependencies = productionProviderDependencies,
): WorkflowTaskServices {
  const providerBundle = providerDependencies.createBundle(environment);
  const agents = createAgentSetFromBundle(providerBundle);
  const classifier = createReplyClassifierFromBundle(providerBundle);
  const runEmailResolution = (payload: {
    contactId: string;
    confidenceThreshold?: number;
  }) => {
    const emailProviders = composeEmailResolutionProviders(
      providerBundle,
      providerDependencies,
    );
    return resolveContactEmail(
      db,
      emailProviders.dns,
      new NoResultEmailEnrichmentProvider(),
      payload,
      {
        publicEvidenceProvider: emailProviders.publicEvidence,
        publicEvidenceOperationTimeoutMs:
          emailProviders.publicEvidenceOperationTimeoutMs,
      },
    );
  };
  const reconcileOneInboundMailbox = async (mailboxId: string) => {
    const [mailbox] = await db
      .select()
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, mailboxId))
      .limit(1);
    if (!mailbox) throw new Error("Mailbox not found");
    const entry = resolveInboundProvider(mailbox.provider);
    if (entry.skipReason) {
      return { skipped: true, reason: entry.skipReason };
    }
    return withInboundReconciliationHealth(
      db,
      mailbox.id,
      entry.naming(mailbox.id),
      async () => {
        const roundStartedAt = new Date();
        const [current] = await db
          .select()
          .from(mailboxConnections)
          .where(eq(mailboxConnections.id, mailbox.id))
          .limit(1);
        if (!current) throw new Error("Mailbox not found");
        const source = await entry.createSource(db, current, { environment });
        const counted = createCountingIngest((message) =>
          ingestMatchedInboundMessage(db, classifier, message),
        );
        const result = await reconcileInboundMailbox(
          { source, mailboxId: current.id },
          {
            loadCursor: async () => current.syncCursor,
            saveCursor: createInboundCursorWriter(db, {
              events: entry.cursorEvents(),
              startedAt: roundStartedAt,
              payload: (round) => ({
                processed: counted.processed(),
                rebaselined: round.rebaselined,
              }),
            }),
            ingest: counted.ingest,
          },
        );
        return {
          processed: result.processed,
          rebaselined: result.rebaselined,
        };
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
    "reconcile-inbound-mailbox": (payload) =>
      reconcileOneInboundMailbox(payload.mailboxId),
    "reconcile-inbound-mailboxes": async (payload) => {
      const rows = await db
        .select({ id: mailboxConnections.id })
        .from(mailboxConnections)
        .where(
          and(
            eq(mailboxConnections.provider, "smtp_imap"),
            eq(mailboxConnections.status, "available"),
          ),
        )
        .limit(payload.limit ?? 50);
      const results = [];
      for (const row of rows) {
        try {
          results.push({
            mailboxId: row.id,
            result: await reconcileOneInboundMailbox(row.id),
          });
        } catch (error) {
          results.push({
            mailboxId: row.id,
            error:
              error instanceof Error
                ? error.message
                : "Inbound reconciliation failed",
          });
        }
      }
      assertInboundBatchSucceeded(results);
      return { observedAt: payload.observedAt, results };
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
