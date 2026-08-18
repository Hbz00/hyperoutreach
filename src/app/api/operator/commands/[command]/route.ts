import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { mutableRedirect } from "@/lib/http-response";
import {
  cookieValue,
  OPERATOR_SESSION_COOKIE,
  verifyCsrfToken,
  verifyOperatorSession,
  safeOperatorRedirect,
} from "@/lib/operator-auth";
import { createOrGetAccount } from "@/modules/accounts/service";
import { createOrGetContact } from "@/modules/contacts/service";
import {
  mailboxConnections,
  messages,
  operatorSendingSettings,
  workflowEvents,
} from "@/lib/db/schema";
import {
  pauseCampaign,
  resumeCampaign,
  stopEnrollment,
} from "@/modules/campaigns/lifecycle-service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
  reviseCampaignVersion,
} from "@/modules/campaigns/service";
import { findAccountContactsNeedingResolution } from "@/modules/email-resolution/account-resolution";
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";
import { disconnectMicrosoftMailbox } from "@/modules/mailboxes/microsoft-oauth-service";
import {
  connectSmtpImapMailbox,
  disconnectSmtpImapMailbox,
  type ConnectSmtpImapMailboxResult,
} from "@/modules/mailboxes/smtp-imap-connection-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendOutcomeNotice } from "@/modules/messages/send-outcome";
import { isTransientSendBlock } from "@/modules/messages/send-policy";
import {
  autoScheduleIntent,
  cancelSendIntent,
  operatorIntentLifetimeMs,
  scheduleSendIntent,
} from "@/modules/messages/scheduled-send";
import {
  readSendPolicyVerdict,
  type SendMessageResult,
} from "@/modules/messages/send-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import { operatorClock } from "@/modules/settings/working-hours";
import {
  addSuppression,
  removeSuppression,
} from "@/modules/suppression/service";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";
import { dispatchMaintenanceTick } from "@/modules/workflows/maintenance-service";
import type { QueuedOperatorCommand } from "@/modules/workflows/operator-command-policy";
import {
  enqueueOperatorCommand,
  requeueOperatorCommand,
  type EnqueuedOperatorCommand,
} from "@/modules/workflows/operator-command-queue";
import { resolveWorkflowProvider } from "@/modules/workflows/provider-config";

export const runtime = "nodejs";
// No operator command issues an AI turn any more: the ones that would are
// queued and drained by the maintenance cycle. What is left runs in the
// request — an SMTP send, bounded to 150 seconds by its provider, and plain
// database work — so the ceiling is a transport margin over that rather than
// a window wide enough for a ten-minute research call.
export const maxDuration = 300;

const createProspectSchema = z.object({
  companyName: z.string().trim().min(1).max(300),
  domain: z.string().trim().max(500).optional(),
  firstName: z.string().trim().min(1).max(200),
  lastName: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().max(500).optional(),
  email: z.string().trim().max(500).optional(),
});

const campaignTypeSchema = z.enum([
  "customer_discovery",
  "commercial_outreach",
  "other",
]);

const uuidSchema = z.uuid();

function value(formData: FormData, key: string): string | undefined {
  const entry = formData.get(key);
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function destination(
  _request: Request,
  path: string,
  notice: string,
): Response {
  const url = new URL(safeOperatorRedirect(path), "http://operator.local");
  url.searchParams.set("notice", notice);
  return mutableRedirect(`${url.pathname}${url.search}${url.hash}`, 303);
}

function integer(formData: FormData, key: string): number | undefined {
  const raw = value(formData, key);
  if (!raw || !/^-?\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function boolean(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

function list(formData: FormData, key: string): string[] {
  return (value(formData, key) ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Operator-facing text for every `connectSmtpImapMailbox` failure code,
 * shown verbatim in the `/settings` redirect notice. `IMAP_FOLDERS_NOT_FOUND`
 * deliberately gets its own sentence, distinct from the two auth codes: a
 * mailbox that authenticated fine over IMAP but whose Drafts/Sent folders
 * could not be identified (e.g. a French Zimbra naming them "Brouillons"/
 * "Envoyés" instead of a recognized special-use or conventional name) is not
 * a wrong-password problem, and an operator who only sees "authentication
 * failed" here will waste time re-typing a password that was never broken.
 */
const CONNECT_SMTP_MAILBOX_NOTICES: Record<
  Extract<ConnectSmtpImapMailboxResult, { ok: false }>["code"],
  string
> = {
  INVALID_INPUT:
    "Mailbox connection failed: check that every field (host, port, username, password) is filled in and valid. (INVALID_INPUT)",
  IMAP_AUTH_FAILED:
    "Mailbox connection failed: IMAP rejected the username or password. (IMAP_AUTH_FAILED)",
  IMAP_CONNECTION_FAILED:
    "Mailbox connection failed: the IMAP endpoint could not be reached or negotiated. Check the host, port, TLS mode, certificate, and network. (IMAP_CONNECTION_FAILED)",
  IMAP_FOLDERS_NOT_FOUND:
    'Mailbox connection failed: IMAP login succeeded, but the Drafts/Sent folders could not be identified — this is not a password problem. Some providers use localized folder names (e.g. "Brouillons"/"Envoyés"); check the mailbox\'s folder configuration. (IMAP_FOLDERS_NOT_FOUND)',
  SMTP_AUTH_FAILED:
    "Mailbox connection failed: SMTP rejected the username or password. (SMTP_AUTH_FAILED)",
  SMTP_CONNECTION_FAILED:
    "Mailbox connection failed: the SMTP endpoint could not be reached or negotiated. Check the host, port, TLS mode, certificate, and network. (SMTP_CONNECTION_FAILED)",
  CONFIGURATION_ERROR:
    "Mailbox connection failed: server misconfiguration — contact an administrator. (CONFIGURATION_ERROR)",
  DATABASE_ERROR:
    "Mailbox connection failed: the mailbox could not be saved — try again. (DATABASE_ERROR)",
};

/**
 * Which sentences a step asks an agent to write, if any.
 *
 * Declared per step because a first email and a third follow-up do not need
 * the same thing, and because the campaign version that carries it is
 * immutable: turning personalization on is a new published version, which is
 * what makes "this text came from that decision" answerable later.
 */
function stepPersonalization(formData: FormData, index: number) {
  const fields = [
    ...(boolean(formData, `step${index}AiOpening`)
      ? (["personalized_opening"] as const)
      : []),
    ...(boolean(formData, `step${index}AiRelevance`)
      ? (["company_relevance"] as const)
      : []),
  ];
  if (fields.length === 0) return undefined;
  const raw = Number(value(formData, `step${index}MinConfidence`) ?? "0.5");
  return {
    fields,
    minConfidence: Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5,
  };
}

function campaignSteps(formData: FormData) {
  const steps = [];
  for (let index = 0; index < 20; index += 1) {
    const subjectTemplate = value(formData, `step${index}Subject`);
    const bodyTemplate = value(formData, `step${index}Body`);
    if (!subjectTemplate && !bodyTemplate) continue;
    const personalizationSchema = stepPersonalization(formData, index);
    steps.push({
      delayMinutes: integer(formData, `step${index}DelayMinutes`) ?? 0,
      subjectTemplate: subjectTemplate ?? "",
      bodyTemplate: bodyTemplate ?? "",
      ...(personalizationSchema ? { personalizationSchema } : {}),
    });
  }
  return steps;
}

/**
 * What the send actually did, read back from the audit row the local executor
 * just wrote. The dispatcher's contract returns a run id, not an outcome — a
 * hosted executor could not return one — so the audit is where the answer
 * lives. A missing row is reported as such rather than assumed successful.
 */
async function recordedSendOutcome(
  runId: string,
): Promise<SendMessageResult | undefined> {
  // Two rows carry this run id — the dispatcher's and the executor's. Only
  // the executor's records what the send returned.
  const [event] = await getDatabase()
    .select({ payload: workflowEvents.payload })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.runId, runId),
        eq(workflowEvents.event, "send-approved-message.attempt"),
      ),
    )
    .limit(1);
  const output = (event?.payload as { output?: unknown } | undefined)?.output;
  return output && typeof output === "object"
    ? (output as SendMessageResult)
    : undefined;
}

/**
 * Asks for a maintenance cycle now, once the operator's page is already back.
 *
 * The cycle's last stage is what drains queued work, so without this the
 * operator waits for the resident worker's next offer — up to a minute of
 * nothing on a queue that is usually empty. There is deliberately no check of
 * whether that queue is idle first: the `maintenance_state` singleton lease
 * already decides who runs, and a cycle asked for while another holds the lease
 * returns `busy` for the cost of one audit row. Checking would only add a race
 * on top of the arbiter that exists to settle it.
 *
 * Best-effort, and it has to be. The queued row is durable and the worker
 * offers again within the minute, so a kick that never lands costs latency and
 * nothing else. That is why the dispatcher is built inside the callback — its
 * factory throws on a misconfigured provider, and the enqueue has already
 * succeeded by then — and why a failed cycle dies here: the cycle records its
 * own failure in `maintenance_state`, which is what "What goes out" reads.
 *
 * `maxDuration` on this route bounds the callback on a platform that enforces
 * it. Being cut short is survivable for the same reason: the lease goes stale
 * after `staleLeaseMs` and the next tick reclaims it.
 */
function askForMaintenanceNow(
  environment: Record<string, string | undefined> = process.env,
): void {
  try {
    // Local execution only. Under Trigger, `maintenance-cycle` is a
    // `schedules.task` whose run reads `payload.timestamp` — the scheduler's
    // own payload, not the `observedAt` this path sends — so a cycle asked for
    // from here would arrive unreadable. Trigger owns that schedule, exactly as
    // it owns the worker the supervisor declines to start.
    if (resolveWorkflowProvider(environment) !== "local") return;
    // The same explicit opt-out the worker honours, parsed the same way — see
    // `maintenanceEnabled` in `scripts/local-maintenance-runtime.mjs`. An
    // installation that has said it drives its own cycles means it: a button
    // press is not a reason to start one behind its back.
    if (
      environment.LOCAL_MAINTENANCE_ENABLED?.trim().toLowerCase() === "false"
    ) {
      return;
    }
    after(async () => {
      try {
        await dispatchMaintenanceTick(createWorkflowDispatcher(), new Date(), {
          immediate: true,
        });
      } catch {
        // The cycle's own failure, already written to `maintenance_state`.
      }
    });
  } catch {
    // Asking failed, which is configuration rather than runtime: an
    // unrecognised `WORKFLOW_PROVIDER`, or `after` outside a request scope.
    // Both are reported loudly where they belong — the supervisor's preflight,
    // the dispatcher factory, the maintenance route — and neither is a reason
    // to turn a queued command into an error the operator has to read.
  }
}

/**
 * Records AI work and hands the page straight back.
 *
 * These commands used to run their agent inside the request, with
 * `maxDuration` at sixteen minutes and no way to show progress — the
 * application ships no client JavaScript. Worse, an agent turn issued from a
 * request competes with the maintenance cycle for the operator's single
 * ChatGPT window, and the loser dies on a deadline it spent entirely in a
 * queue. The notice says queued rather than done, because that is what
 * happened.
 */
async function queued(
  request: Request,
  input: {
    command: QueuedOperatorCommand;
    label: string;
    actor: string;
    returnTo: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<Response> {
  let enqueued: EnqueuedOperatorCommand;
  // Scoped to the write, and only the write: everything after it happened, and
  // "not queued" has to keep meaning that the row is not there.
  try {
    enqueued = await enqueueOperatorCommand(getDatabase(), {
      command: input.command,
      payload: input.payload,
      requestedBy: input.actor,
      dedupeKey: input.dedupeKey,
    });
  } catch {
    return destination(request, input.returnTo, `${input.label} not queued`);
  }
  // Including on a duplicate. The second press is the same request as the
  // first, and the row it found may be one parked on a precondition the
  // operator has since lifted — a pass is what re-reads it.
  askForMaintenanceNow();
  return destination(
    request,
    input.returnTo,
    enqueued.duplicate
      ? `${input.label} is already queued`
      : `${input.label} queued — it starts as soon as the maintenance pass is free`,
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ command: string }> },
) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const session = verifyOperatorSession(
    cookieValue(request, OPERATOR_SESSION_COOKIE),
  );
  if (!session)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const csrf = formData.get("csrf");
  if (!verifyCsrfToken(session, typeof csrf === "string" ? csrf : null)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const { command } = await params;
  const db = getDatabase();

  if (command === "create-prospect") {
    const parsed = createProspectSchema.safeParse({
      companyName: formData.get("companyName"),
      domain: value(formData, "domain"),
      firstName: formData.get("firstName"),
      lastName: formData.get("lastName"),
      jobTitle: value(formData, "jobTitle"),
      email: value(formData, "email"),
    });
    if (!parsed.success) {
      return destination(request, "/prospects", "Invalid prospect details");
    }
    const account = await createOrGetAccount(db, {
      name: parsed.data.companyName,
      domain: parsed.data.domain,
    });
    if (!account.ok) {
      return destination(request, "/prospects", account.message);
    }
    const contact = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      jobTitle: parsed.data.jobTitle,
    });
    if (!contact.ok) {
      return destination(request, "/prospects", contact.message);
    }
    if (parsed.data.email) {
      const accepted = await acceptManualEmail(db, {
        contactId: contact.contact.id,
        email: parsed.data.email,
        actor: session.email,
      });
      if (!accepted.ok) {
        return destination(
          request,
          `/prospects/${contact.contact.id}`,
          `Prospect saved; email was not accepted (${accepted.code})`,
        );
      }
    }
    return destination(
      request,
      `/prospects/${contact.contact.id}`,
      account.disposition === "existing" || contact.disposition === "existing"
        ? "Existing prospect reused"
        : "Prospect created",
    );
  }

  if (command === "discover-accounts") {
    const icp = value(formData, "icp");
    const limit = integer(formData, "limit") ?? 10;
    if (!icp) return destination(request, "/prospects", "ICP is required");
    return queued(request, {
      command: "discover-accounts",
      label: "Account discovery",
      actor: session.email,
      returnTo: "/prospects",
      dedupeKey: `ui:account-discovery:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: {
        icp,
        limit,
        countries: list(formData, "countries"),
        industries: list(formData, "industries"),
        requiredSignals: list(formData, "requiredSignals"),
      },
    });
  }

  if (command === "research-account") {
    const accountId = value(formData, "accountId");
    if (!uuidSchema.safeParse(accountId).success) {
      return destination(request, "/prospects", "Invalid account");
    }
    return queued(request, {
      command: "research-account",
      label: "Account research",
      actor: session.email,
      returnTo: value(formData, "returnTo") ?? "/prospects",
      dedupeKey: `ui:account-research:${accountId}:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: { accountId: accountId!, force: boolean(formData, "force") },
    });
  }

  if (command === "discover-contacts") {
    const accountId = value(formData, "accountId");
    const roles = list(formData, "roles");
    if (!uuidSchema.safeParse(accountId).success || roles.length === 0) {
      return destination(
        request,
        "/prospects",
        "Invalid contact discovery input",
      );
    }
    return queued(request, {
      command: "discover-contacts",
      label: "Contact discovery",
      actor: session.email,
      returnTo: value(formData, "returnTo") ?? "/prospects",
      dedupeKey: `ui:contact-discovery:${accountId}:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: {
        accountId: accountId!,
        roles,
        limit: integer(formData, "limit") ?? 10,
      },
    });
  }

  if (command === "resolve-email") {
    const contactId = value(formData, "contactId");
    if (!uuidSchema.safeParse(contactId).success) {
      return destination(request, "/prospects", "Invalid contact");
    }
    return queued(request, {
      command: "resolve-email",
      label: "Email resolution",
      actor: session.email,
      returnTo: `/prospects/${contactId}`,
      dedupeKey: `ui:email-resolution:${contactId}:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: {
        contactId: contactId!,
        confidenceThreshold: Number(
          value(formData, "confidenceThreshold") ?? "0.85",
        ),
        forcePublicSearch: boolean(formData, "forcePublicSearch"),
      },
    });
  }

  /**
   * The company, not the person, is the unit of resolution.
   *
   * One button asks the model the company's convention once and applies it to
   * every contact who still needs an address — which is what the search was
   * always about. The per-contact action survives for the exception; this is the
   * normal path.
   *
   * A forced re-search rides on the first queued contact and on no other. The
   * flag on all of them would spend a live web search per person, which is the
   * cost this whole direction exists to remove.
   */
  if (command === "resolve-account-emails") {
    const accountId = value(formData, "accountId");
    if (!uuidSchema.safeParse(accountId).success) {
      return destination(request, "/prospects", "Invalid account");
    }
    const returnTo = value(formData, "returnTo") ?? "/prospects";
    const force = boolean(formData, "forcePublicSearch");
    const eligible = await findAccountContactsNeedingResolution(db, {
      accountId: accountId!,
      includeResolved: force,
    });
    if (eligible.length === 0) {
      return destination(
        request,
        returnTo,
        "Every contact at this company already has an address, or has already been written to",
      );
    }
    const requestToken = value(formData, "requestToken") ?? randomUUID();
    const threshold = Number(value(formData, "confidenceThreshold") ?? "0.85");
    let queued = 0;
    try {
      for (const [index, row] of eligible.entries()) {
        await enqueueOperatorCommand(db, {
          command: "resolve-email",
          payload: {
            contactId: row.contactId,
            confidenceThreshold: Number.isFinite(threshold) ? threshold : 0.85,
            forcePublicSearch: force && index === 0,
          },
          requestedBy: session.email,
          dedupeKey: `ui:account-email-resolution:${accountId}:${requestToken}:${row.contactId}`,
        });
        queued += 1;
      }
    } catch {
      return destination(
        request,
        returnTo,
        queued === 0
          ? "Address resolution not queued"
          : `Address resolution queued for ${queued} of ${eligible.length} contacts`,
      );
    }
    askForMaintenanceNow();
    return destination(
      request,
      returnTo,
      `Address resolution queued for ${queued} contact${queued > 1 ? "s" : ""} — one company search covers all of them`,
    );
  }

  if (command === "accept-manual-email") {
    const contactId = value(formData, "contactId");
    const result = await acceptManualEmail(db, {
      contactId,
      email: value(formData, "email"),
      actor: session.email,
    });
    return destination(
      request,
      uuidSchema.safeParse(contactId).success
        ? `/prospects/${contactId}`
        : "/prospects",
      result.ok ? "Email accepted" : `Email not accepted (${result.code})`,
    );
  }

  if (command === "create-campaign") {
    const type = campaignTypeSchema.safeParse(value(formData, "type"));
    const result = await createDraftCampaign(db, {
      name: value(formData, "name"),
      type: type.success ? type.data : undefined,
      targetDescription: value(formData, "targetDescription"),
      configuration: {
        // Passed through on purpose so the schema can refuse it out loud. The
        // key is not a setting any more, and a request still carrying it is
        // asking for something this build does not do — silently dropping it
        // would let the caller believe otherwise.
        ...(formData.has("reviewMode")
          ? { reviewMode: value(formData, "reviewMode") }
          : {}),
        automaticFollowUps: boolean(formData, "automaticFollowUps"),
        holdNonTerminalReplies: boolean(formData, "holdNonTerminalReplies"),
        requireProfessionalRelevance: boolean(
          formData,
          "requireProfessionalRelevance",
        ),
        campaignDailyCap: integer(formData, "campaignDailyCap"),
      },
      steps: campaignSteps(formData),
    });
    return result.ok
      ? destination(
          request,
          `/campaigns/${result.campaign.id}`,
          "Campaign draft created",
        )
      : destination(request, "/campaigns", result.message);
  }

  if (command === "revise-campaign") {
    const campaignId = value(formData, "campaignId");
    const result = await reviseCampaignVersion(db, {
      campaignId,
      baseVersionId: value(formData, "campaignVersionId"),
      configuration: {
        // Passed through on purpose so the schema can refuse it out loud. The
        // key is not a setting any more, and a request still carrying it is
        // asking for something this build does not do — silently dropping it
        // would let the caller believe otherwise.
        ...(formData.has("reviewMode")
          ? { reviewMode: value(formData, "reviewMode") }
          : {}),
        automaticFollowUps: boolean(formData, "automaticFollowUps"),
        holdNonTerminalReplies: boolean(formData, "holdNonTerminalReplies"),
        requireProfessionalRelevance: boolean(
          formData,
          "requireProfessionalRelevance",
        ),
        campaignDailyCap: integer(formData, "campaignDailyCap"),
      },
      steps: campaignSteps(formData),
    });
    return destination(
      request,
      uuidSchema.safeParse(campaignId).success
        ? `/campaigns/${campaignId}`
        : "/campaigns",
      result.ok ? "Campaign version saved" : result.message,
    );
  }

  if (command === "publish-campaign") {
    const campaignId = value(formData, "campaignId");
    const result = await publishCampaignVersion(db, {
      campaignId,
      campaignVersionId: value(formData, "campaignVersionId"),
    });
    return destination(
      request,
      uuidSchema.safeParse(campaignId).success
        ? `/campaigns/${campaignId}`
        : "/campaigns",
      result.ok ? "Campaign version published" : result.message,
    );
  }

  if (command === "pause-campaign" || command === "resume-campaign") {
    const campaignId = value(formData, "campaignId");
    const result =
      command === "pause-campaign"
        ? await pauseCampaign(db, { campaignId, actor: session.email })
        : await resumeCampaign(db, { campaignId, actor: session.email });
    return destination(
      request,
      uuidSchema.safeParse(campaignId).success
        ? `/campaigns/${campaignId}`
        : "/campaigns",
      result.ok
        ? command === "pause-campaign"
          ? "Campaign paused"
          : "Campaign resumed"
        : `Campaign action failed (${result.code})`,
    );
  }

  if (command === "enroll-contact") {
    const campaignId = value(formData, "campaignId");
    const result = await enrollContact(db, {
      campaignId,
      campaignVersionId: value(formData, "campaignVersionId"),
      contactId: value(formData, "contactId"),
      mailboxId: value(formData, "mailboxId") ?? null,
    });
    // Enrolling writes the step-zero generation into the queue in its own
    // transaction, so a fresh enrolment is queued work like any other. An
    // existing one queued nothing, and has nothing to ask a pass for.
    if (result.ok && result.disposition === "created") askForMaintenanceNow();
    return destination(
      request,
      uuidSchema.safeParse(campaignId).success
        ? `/campaigns/${campaignId}`
        : "/campaigns",
      result.ok
        ? result.disposition === "existing"
          ? "Contact already enrolled"
          : "Contact enrolled — their first message is queued"
        : result.message,
    );
  }

  if (command === "stop-enrollment") {
    const enrollmentId = value(formData, "enrollmentId");
    const result = await stopEnrollment(db, {
      enrollmentId,
      actor: session.email,
    });
    return destination(
      request,
      value(formData, "returnTo") ?? "/prospects",
      result.ok ? "Enrollment stopped" : `Stop failed (${result.code})`,
    );
  }

  if (command === "generate-message") {
    const enrollmentId = value(formData, "enrollmentId");
    const stepIndex = integer(formData, "stepIndex") ?? 0;
    if (!uuidSchema.safeParse(enrollmentId).success) {
      return destination(request, "/review", "Invalid enrollment");
    }
    // The recipient is resolved when the work runs, not here: a prospect whose
    // address is still being resolved is something to wait for, not an error
    // to show. The old key was `ui:generate:<enrollment>:<step>` with no
    // request token, so every later attempt on the same step deduplicated into
    // a permanent no-op.
    return queued(request, {
      command: "generate-message",
      label: "Message generation",
      actor: session.email,
      returnTo: "/review",
      dedupeKey: `ui:generate:${enrollmentId}:${stepIndex}:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: { enrollmentId: enrollmentId!, stepIndex },
    });
  }

  if (command === "review-message") {
    const messageId = value(formData, "messageId");
    const action = value(formData, "reviewAction");
    if (
      !uuidSchema.safeParse(messageId).success ||
      !["approve", "edit_and_approve", "reject"].includes(action ?? "")
    ) {
      return destination(request, "/review", "Invalid review action");
    }
    const reviewAction =
      action === "edit_and_approve"
        ? {
            kind: "edit_and_approve" as const,
            subject: value(formData, "subject") ?? "",
            body: value(formData, "body") ?? "",
          }
        : action === "reject"
          ? {
              kind: "reject" as const,
              reason: value(formData, "reason") ?? "Rejected by operator",
            }
          : { kind: "approve" as const };
    const result = await reviewMessage(db, {
      messageId,
      action: reviewAction,
      actor: session.email,
    });
    return destination(
      request,
      "/review",
      result.ok
        ? reviewAction.kind === "reject"
          ? "Message rejected"
          : "Message approved"
        : result.message,
    );
  }

  if (command === "send-message") {
    const messageId = value(formData, "messageId");
    if (!uuidSchema.safeParse(messageId).success)
      return destination(request, "/review", "Invalid message");
    try {
      const dispatched = await createWorkflowDispatcher().dispatch({
        task: "send-approved-message",
        payload: { messageId: messageId! },
        // Per rendered form, like every other operator command: a send the
        // policy declines (working hours, cap, suppression) resolves rather
        // than throws, so a message-wide key would be recorded as succeeded
        // and every later click on this message deduplicated into a no-op.
        // The send service's own claim keeps concurrent clicks safe.
        idempotencyKey: `ui:send:${messageId}:${value(formData, "requestToken") ?? randomUUID()}`,
      });
      const outcome = await recordedSendOutcome(dispatched.runId);
      // A refusal time alone will lift is taken on without asking when it is
      // close, and offered rather than assumed when it is not. The line is an
      // hour: nobody wants to think about the sixty-second pacing delay, and
      // nobody wants a Friday-evening click to leave on Monday morning without
      // having said so.
      //
      // Written here, from the operator's own click, and never inside
      // `sendApprovedMessage` — that function is also called by the automatic
      // follow-up and by stale-work recovery, and letting either of them write
      // an intent would be the system scheduling its own sends.
      if (outcome && !outcome.ok && isTransientSendBlock(outcome.code)) {
        const now = new Date();
        const [settings] = await db
          .select()
          .from(operatorSendingSettings)
          .where(eq(operatorSendingSettings.id, 1))
          .limit(1);
        // One rule, decided outside the route: whether this refusal is close
        // enough to take on, at which instant, and for how long. The instant
        // is the one a send could legally leave at rather than the one the
        // named obstacle clears at — at 17:59 the sixty-second pacing delay
        // ends at 18:00:30 and nothing may leave then, so the wait is not a
        // minute, it is tomorrow morning, and tomorrow morning is a decision.
        // The lifetime is granted because the instant was close, so the two
        // are answered together and cannot drift apart here.
        const auto = settings
          ? autoScheduleIntent(outcome.code, now, settings)
          : null;
        if (auto) {
          const scheduled = await scheduleSendIntent(db, {
            messageId: messageId!,
            now,
            // The instant just shown to the operator is the instant stored, so
            // the notice and the queue cannot disagree.
            ...auto,
          });
          if (scheduled.ok) {
            return destination(
              request,
              "/review",
              `${sendOutcomeNotice(outcome)} — going out on its own at ${operatorClock(scheduled.scheduledAt, scheduled.timezone)}`,
            );
          }
        }
        // Far enough away to be a decision. The refusal stands, and the review
        // card offers the schedule rather than this taking it — but only while
        // the message is still `approved`. A send refused at the final check
        // has already moved to `drafted`, where the card offers nothing and the
        // route would refuse anyway; item 0's window hands it back shortly.
        const [current] = await db
          .select({ status: messages.status })
          .from(messages)
          .where(eq(messages.id, messageId!))
          .limit(1);
        return destination(
          request,
          "/review",
          current?.status === "approved"
            ? `${sendOutcomeNotice(outcome)} — not scheduled; the review card offers it if you want to wait`
            : `${sendOutcomeNotice(outcome)} — not scheduled; it returns to the review queue shortly`,
        );
      }
      return destination(request, "/review", sendOutcomeNotice(outcome));
    } catch {
      return destination(request, "/review", "Send execution failed safely");
    }
  }

  if (command === "schedule-send") {
    const messageId = value(formData, "messageId");
    if (!uuidSchema.safeParse(messageId).success)
      return destination(request, "/review", "Invalid message");
    const clickedAt = new Date();
    // Which refusal this click is accepting, re-read here rather than trusted
    // from the form. The card's button names the instant that refusal clears,
    // and the intent has to be able to live to it: with the shipped 24-hour
    // contact delay, a day counted from the click ends on the very instant the
    // button promised, and the lane expires it five minutes before the only
    // look that could have sent it. One policy read on one click buys the
    // difference between a promise kept and a click that dies overnight.
    const [context] = await db
      .select({
        provider: mailboxConnections.provider,
        settings: operatorSendingSettings,
      })
      .from(messages)
      .leftJoin(
        mailboxConnections,
        eq(mailboxConnections.id, messages.mailboxId),
      )
      .innerJoin(operatorSendingSettings, eq(operatorSendingSettings.id, 1))
      .where(eq(messages.id, messageId!))
      .limit(1);
    const verdict = context
      ? await readSendPolicyVerdict(
          db,
          messageId!,
          context.provider ?? "mock",
          clickedAt,
        )
      : null;
    const lifetimeMs =
      context && verdict && !verdict.ok && isTransientSendBlock(verdict.code)
        ? operatorIntentLifetimeMs(verdict.code, clickedAt, context.settings)
        : undefined;
    const scheduled = await scheduleSendIntent(db, {
      messageId: messageId!,
      now: clickedAt,
      ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
    });
    return destination(
      request,
      "/review",
      scheduled.ok
        ? // A refusal with a nameable end gets named. A rolling daily cap has
          // none, and the lane's first look is simply "now" — announcing the
          // instant of the click as the delivery time would say something
          // false about a wait that can last most of a day.
          scheduled.scheduledAt.getTime() > clickedAt.getTime()
          ? `Scheduled for ${operatorClock(scheduled.scheduledAt, scheduled.timezone)}`
          : "Scheduled — it goes out at the first instant the policy allows"
        : scheduled.code === "NO_WORKING_SLOT"
          ? "Not scheduled: no working day is configured"
          : scheduled.code === "ALREADY_SCHEDULED"
            ? "Already scheduled"
            : "Not scheduled: the message is no longer waiting to be sent",
    );
  }

  if (command === "cancel-scheduled-send") {
    const messageId = value(formData, "messageId");
    if (!uuidSchema.safeParse(messageId).success)
      return destination(request, "/review", "Invalid message");
    const cancelled = await cancelSendIntent(db, messageId!);
    return destination(
      request,
      "/review",
      cancelled
        ? "Scheduled send cancelled"
        : // The lane claimed it between the render and the click. Saying
          // "cancelled" here would be the kind of lie this iteration spent its
          // time removing.
          "Nothing to cancel — this send is already on its way",
    );
  }

  if (command === "retry-command") {
    const commandId = value(formData, "commandId");
    if (!uuidSchema.safeParse(commandId).success) {
      return destination(request, "/outbound", "Invalid command");
    }
    const requeued = await requeueOperatorCommand(db, { id: commandId! });
    if (requeued) askForMaintenanceNow();
    return destination(
      request,
      "/outbound",
      requeued
        ? "Queued again — it starts as soon as the maintenance pass is free"
        : "That command is not waiting for a retry",
    );
  }

  if (command === "reconcile-followups") {
    const observedAt = new Date().toISOString();
    try {
      await createWorkflowDispatcher().dispatch({
        task: "reconcile-due-follow-ups",
        payload: { observedAt, limit: 100 },
        idempotencyKey: `ui:due-followups:${observedAt}`,
      });
      return destination(request, "/review", "Due follow-ups reconciled");
    } catch {
      return destination(
        request,
        "/review",
        "Follow-up reconciliation failed safely",
      );
    }
  }

  if (command === "inject-reply") {
    if (process.env.MAIL_PROVIDER === "microsoft_graph") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const messageId = value(formData, "messageId");
    const [outbound] = await db
      .select({ message: messages, mailbox: mailboxConnections })
      .from(messages)
      .innerJoin(
        mailboxConnections,
        eq(mailboxConnections.id, messages.mailboxId),
      )
      .where(
        eq(messages.id, messageId ?? "00000000-0000-0000-0000-000000000000"),
      )
      .limit(1);
    if (
      !outbound ||
      outbound.message.direction !== "outbound" ||
      outbound.mailbox.provider !== "mock"
    ) {
      return destination(request, "/inbox", "Outbound message not found");
    }
    // The injector runs in the request, so it uses the deterministic
    // classifier rather than the configured one. A live classification here
    // would take a turn on the operator's ChatGPT window while the maintenance
    // cycle may be holding it, and a turn's deadline counts its queue wait —
    // one of the two would die. Determinism is also what a test injector wants.
    const result = await ingestInboundMessage(
      db,
      new DeterministicReplyClassifier(),
      {
        mailboxId: outbound.mailbox.id,
        providerMessageId: `mock_reply_${randomUUID()}`,
        outreachId: outbound.message.outreachId ?? undefined,
        conversationId: outbound.message.conversationId ?? undefined,
        inReplyTo: outbound.message.internetMessageId ?? undefined,
        sender: outbound.message.recipient,
        recipient: outbound.mailbox.email,
        subject:
          value(formData, "subject") ?? `Re: ${outbound.message.subject}`,
        body: value(formData, "body") ?? "",
        receivedAt: new Date(),
        metadata: { injectedBy: session.email },
      },
    );
    return destination(
      request,
      "/inbox",
      result.ok ? "Reply ingested" : `Reply ingestion failed (${result.code})`,
    );
  }

  if (command === "update-settings") {
    const result = await updateOperatorSendingSettings(db, {
      emergencyPause: boolean(formData, "emergencyPause"),
      timezone: value(formData, "timezone"),
      workingDays: formData.getAll("workingDays").map(Number),
      workingStartMinute: integer(formData, "workingStartMinute"),
      workingEndMinute: integer(formData, "workingEndMinute"),
      mailboxDailyCap: integer(formData, "mailboxDailyCap"),
      campaignDailyCap: integer(formData, "campaignDailyCap"),
      mailboxMinimumDelaySeconds: integer(
        formData,
        "mailboxMinimumDelaySeconds",
      ),
      contactMinimumDelayMinutes: integer(
        formData,
        "contactMinimumDelayMinutes",
      ),
      crossCampaignCooldownDays: integer(formData, "crossCampaignCooldownDays"),
      // An unchecked checkbox is not submitted at all, so `boolean()` returning
      // false for an absent field is what makes this switch turn *off* as well
      // as on. Every numeric field below reads as `undefined` when blank, which
      // the update schema treats as "leave it alone".
      addressLadderEnabled: boolean(formData, "addressLadderEnabled"),
      addressLadderMaxRungs: integer(formData, "addressLadderMaxRungs"),
      addressLadderMaxAdvancesPerAccountPerDay: integer(
        formData,
        "addressLadderMaxAdvancesPerAccountPerDay",
      ),
      addressLadderFailureRatePercent: integer(
        formData,
        "addressLadderFailureRatePercent",
      ),
      addressLadderFailureRateMinimumSends: integer(
        formData,
        "addressLadderFailureRateMinimumSends",
      ),
      addressLadderDemotionMinimumPeople: integer(
        formData,
        "addressLadderDemotionMinimumPeople",
      ),
      addressLadderDemotionFailureSharePercent: integer(
        formData,
        "addressLadderDemotionFailureSharePercent",
      ),
      actor: session.email,
    });
    return destination(
      request,
      "/settings",
      result.ok
        ? "Sending policy updated"
        : `Settings update failed (${result.code})`,
    );
  }

  if (command === "sync-mailbox") {
    const mailboxId = value(formData, "mailboxId");
    if (!uuidSchema.safeParse(mailboxId).success)
      return destination(request, "/settings", "Invalid mailbox");
    return queued(request, {
      command: "sync-mailbox",
      label: "Mailbox sync",
      actor: session.email,
      returnTo: "/settings",
      dedupeKey: `ui:inbound-sync:${mailboxId}:${value(formData, "requestToken") ?? randomUUID()}`,
      payload: { mailboxId: mailboxId! },
    });
  }

  if (command === "disconnect-mailbox") {
    const mailboxId = value(formData, "mailboxId");
    if (!uuidSchema.safeParse(mailboxId).success)
      return destination(request, "/settings", "Invalid mailbox");
    try {
      // Dispatched by the row's own provider — `disconnectMicrosoftMailbox`
      // and `disconnectSmtpImapMailbox` each only accept their own provider
      // (returning `NOT_FOUND` otherwise), so a single lookup here decides
      // which one to call rather than trying both.
      const [mailbox] = await db
        .select({ provider: mailboxConnections.provider })
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, mailboxId!))
        .limit(1);
      const result =
        mailbox?.provider === "smtp_imap"
          ? await disconnectSmtpImapMailbox(db, mailboxId!)
          : await disconnectMicrosoftMailbox(db, mailboxId!);
      return destination(
        request,
        "/settings",
        result.ok ? "Mailbox disconnected" : "Mailbox disconnect failed",
      );
    } catch {
      return destination(
        request,
        "/settings",
        "Mailbox disconnect failed safely",
      );
    }
  }

  // The single command that ever writes `status: "available"` for an
  // `smtp_imap` mailbox — both for a brand-new address and, because
  // `connectSmtpImapMailbox` updates any existing row for the same
  // `(provider, normalized_email)` rather than inserting blindly, for
  // resurrecting one the auto-revocation guard (Task 10 bis) put into
  // `revoked`. Verification (IMAP auth + folder discovery, then SMTP
  // auth — never a real send) happens before any write; a failure never
  // touches the row and reports its cause via the redirect notice, same as
  // every command below.
  if (command === "connect-smtp-mailbox") {
    const result = await connectSmtpImapMailbox(db, {
      email: value(formData, "email"),
      password: value(formData, "password"),
      // No `?? value(formData, "email")` fallback: on the target Zimbra
      // server (and most non-Gmail-style IMAP/SMTP setups) the login
      // username is *not* the email address (the settings form's own
      // placeholder shows "corentin.sacazes", not an address) — silently
      // substituting the email for a blank `username` (a direct POST that
      // bypasses the HTML `required` attribute, or any future caller of
      // this command) would authenticate with the wrong identity, fail with
      // a confusing IMAP/SMTP error, and — for a mailbox being *reconnected*
      // rather than connected fresh — risk tripping the auto-revocation
      // guard on the next send. An empty/missing `username` is rejected
      // explicitly by `connectionInputSchema`'s own `min(1)` instead, same
      // as `email`/`password` already are.
      username: value(formData, "username"),
      imap: {
        host: value(formData, "imapHost"),
        port: integer(formData, "imapPort"),
        security: value(formData, "imapSecurity"),
      },
      smtp: {
        host: value(formData, "smtpHost"),
        port: integer(formData, "smtpPort"),
        security: value(formData, "smtpSecurity"),
      },
    });
    return destination(
      request,
      "/settings",
      result.ok
        ? "Mailbox connected"
        : CONNECT_SMTP_MAILBOX_NOTICES[result.code],
    );
  }

  if (command === "add-suppression") {
    const result = await addSuppression(db, {
      scope: value(formData, "scope"),
      value: value(formData, "value"),
      reason: value(formData, "reason") ?? "manual",
      notes: value(formData, "notes"),
      actor: session.email,
    });
    return destination(
      request,
      "/settings",
      result.ok ? "Suppression saved" : `Suppression failed (${result.code})`,
    );
  }

  if (command === "remove-suppression") {
    const result = await removeSuppression(db, {
      id: value(formData, "id"),
      actor: session.email,
      justification: value(formData, "justification"),
      confirmedResubscription: boolean(formData, "confirmedResubscription"),
      verifiedAddressOverride: boolean(formData, "verifiedAddressOverride"),
    });
    return destination(
      request,
      "/settings",
      result.ok
        ? result.disposition === "removed"
          ? "Suppression removed"
          : "Suppression already absent"
        : `Suppression removal failed (${result.code})`,
    );
  }

  return Response.json({ error: "Unknown operator command" }, { status: 404 });
}
