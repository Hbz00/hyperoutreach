import { and, asc, eq, ne } from "drizzle-orm";

import { enrollments, mailboxConnections, messages } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { requireMicrosoftConfig } from "@/lib/microsoft/config";
import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import type { AIProviderBundle } from "@/lib/ai/provider-bundle";
import { createAgentSetFromBundle } from "@/modules/agents/factory";
import {
  MockDnsMxResolver,
  NodeDnsMxResolver,
  type DnsMxResolver,
} from "@/modules/email-resolution/dns";
import { NoResultEmailEnrichmentProvider } from "@/modules/email-resolution/providers";
import {
  StructuredPublicEmailEvidenceProvider,
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
import { generateWithPersonalization } from "@/modules/messages/personalized-generation";
import {
  readSendPolicyVerdict,
  sendApprovedMessage,
} from "@/modules/messages/send-service";
import { dispatchScheduledSends } from "@/modules/messages/scheduled-send";
import { createReplyClassifierFromBundle } from "@/modules/replies/classifier-factory";
import {
  ingestMatchedInboundMessage,
  reconcilePendingInboundRecords,
} from "@/modules/replies/inbound-service";
import { discoverAccounts } from "@/modules/research/account-discovery-service";
import { researchAccount } from "@/modules/research/account-research-service";
import { discoverContacts } from "@/modules/research/contact-discovery-service";
import { personalizeReasoningFields } from "@/modules/research/personalization-service";
import {
  WorkflowRuntime,
  type WorkflowTaskServices,
} from "@/modules/workflows/runtime";
import {
  drainOperatorCommands,
  type OperatorCommandExecutor,
} from "@/modules/workflows/operator-command-queue";
import type { WorkflowTaskName } from "@/modules/workflows/task-contracts";
import { runMaintenanceCycle } from "@/modules/workflows/maintenance-cycle-service";
import {
  findDueEnrollments,
  processFollowUpInvocation,
} from "@/modules/workflows/follow-up-service";
import {
  findStaleRecoveryCandidates,
  releaseExpiredSendRequests,
} from "@/modules/workflows/recovery-service";

function observedDate(value: string | undefined): Date {
  return value ? new Date(value) : new Date();
}

// One slow or manually-synchronizing mailbox must not permanently pin every
// later mailbox behind it. Keep this deliberately below the PostgreSQL pool
// size: each reconciliation owns a reserved advisory-lock session, while the
// aggregate heartbeat and ordinary queries still need connections.
const INBOUND_MAILBOX_CONCURRENCY = 2;

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
    publicEvidence: new StructuredPublicEmailEvidenceProvider(
      bundle.research.provider,
      bundle.research.model,
      bundle.research.effort,
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
  const services = {
    "account-discovery": (payload) =>
      discoverAccounts(db, agents.accountDiscovery, payload),
    "account-research": (payload) =>
      researchAccount(db, agents.accountResearch, payload),
    "contact-discovery": (payload) =>
      discoverContacts(db, agents.contactDiscovery, payload),
    "email-resolution": runEmailResolution,
    "personalize-message": (payload) =>
      personalizeReasoningFields(db, agents.personalization, payload),
    "generate-message": (payload) =>
      generateWithPersonalization(db, agents.personalization, payload),
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
      const availableMailboxes = db
        .select({ id: mailboxConnections.id })
        .from(mailboxConnections)
        .where(
          and(
            ne(mailboxConnections.provider, "mock"),
            eq(mailboxConnections.status, "available"),
          ),
        )
        .orderBy(asc(mailboxConnections.id));
      const rows =
        payload.limit === undefined
          ? await availableMailboxes
          : await availableMailboxes.limit(payload.limit);
      const results: Array<
        | { mailboxId: string; result: unknown }
        | { mailboxId: string; error: string }
      > = new Array(rows.length);
      let nextIndex = 0;
      const reconcileNext = async (): Promise<void> => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const row = rows[index];
          if (!row) return;
          try {
            results[index] = {
              mailboxId: row.id,
              result: await reconcileOneInboundMailbox(row.id),
            };
          } catch (error) {
            results[index] = {
              mailboxId: row.id,
              error:
                error instanceof Error
                  ? error.message
                  : "Inbound reconciliation failed",
            };
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(INBOUND_MAILBOX_CONCURRENCY, rows.length) },
          () => reconcileNext(),
        ),
      );
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
      // Before looking for work to finish, give back the work this worker is
      // no longer allowed to finish. Running it first means an expired request
      // is never both excluded from recovery and hidden from the operator.
      const sendRequestsReleased = await releaseExpiredSendRequests(db, {
        now,
      });
      // The scheduled lane rides in this stage rather than in one of its own:
      // it is message lifecycle work like the release above, it issues no AI
      // turn, and giving it a stage would cost budget for a query that is
      // usually empty. Its own query, though — `findStaleRecoveryCandidates`
      // still cannot see an `approved` message, and that stays true.
      //
      // No `now`, deliberately, and this is the one place in this stage where
      // that matters. `observedAt` is the instant the tick started, and this
      // stage runs third: inbound and followups may have taken minutes before
      // it. The rest of the stage completes work the operator already asked
      // for and is bounded by its own window, so a stale clock only makes it
      // late. This lane *originates* a delivery, and judging a delivery
      // against a window that has since shut is the exact failure the whole
      // area exists to prevent. It reads the wall clock, and hands the same
      // instant to the verdict and to the send.
      const scheduledSends = await dispatchScheduledSends(
        db,
        async (messageId, at) =>
          readSendPolicyVerdict(
            db,
            messageId,
            (await providerForMessage(messageId, db, environment)).kind,
            at,
          ),
        async (messageId, at) => {
          const result = await sendApprovedMessage(
            db,
            await providerForMessage(messageId, db, environment),
            { messageId },
            { clock: () => at },
          );
          return result.ok ? { ok: true } : { ok: false, code: result.code };
        },
      );
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
            // The wall clock, for the same reason the scheduled lane above
            // uses it. Selecting these candidates against the tick's instant
            // is fine — a stale clock only makes recovery late, and the
            // request's own window is what bounds how long it may still be
            // completed. But completing one is a *delivery*, and most of the
            // time this is the only path that reaches a provider in this
            // stage: a candidate whose claim is still standing is reconciled
            // and released, while a `drafted` message with a live request and
            // no attempt behind it goes through the policy and out. Judged on
            // an instant up to a whole stage old, that send leaves after the
            // window it was measured against has already shut.
            { clock: () => new Date() },
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
        sendRequestsReleased,
        scheduledSends,
        messagesRecovered,
        researchRecovered,
        resolutionsRecovered,
        followUpsRecovered,
      };
    },
  } as WorkflowTaskServices;
  // Queued operator work runs through the same audited path a dispatched task
  // would, so a command has the same trail as everything else; the queue only
  // decides when there is an attempt and when to stop making them.
  const runQueuedCommand: OperatorCommandExecutor = (input) =>
    new WorkflowRuntime(db, services).execute(
      input.task as WorkflowTaskName,
      input.payload,
      { runId: input.runId, attempt: input.attempt },
    );
  services["maintenance-cycle"] = (payload) =>
    runMaintenanceCycle(
      db,
      {
        "reconcile-inbound-mailboxes": services["reconcile-inbound-mailboxes"],
        "reconcile-due-follow-ups": services["reconcile-due-follow-ups"],
        "recover-stale-work": services["recover-stale-work"],
        // Deliberately the wall clock, not the cycle's observed instant. This
        // stage runs last, after upstream stages that can each take minutes,
        // so the tick's `observedAt` is stale by then — back-dating a claim
        // would shorten its lease, and back-dating a backoff would shorten the
        // wait it exists to impose.
        "drain-operator-commands": () =>
          drainOperatorCommands(db, runQueuedCommand),
      },
      payload,
    );
  return services;
}
