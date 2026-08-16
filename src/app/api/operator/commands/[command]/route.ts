import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
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
import { mailboxConnections, messages, workflowEvents } from "@/lib/db/schema";
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
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";
import { disconnectMicrosoftMailbox } from "@/modules/mailboxes/microsoft-oauth-service";
import {
  connectSmtpImapMailbox,
  disconnectSmtpImapMailbox,
  type ConnectSmtpImapMailboxResult,
} from "@/modules/mailboxes/smtp-imap-connection-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendOutcomeNotice } from "@/modules/messages/send-outcome";
import type { SendMessageResult } from "@/modules/messages/send-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import {
  addSuppression,
  removeSuppression,
} from "@/modules/suppression/service";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";
import type { QueuedOperatorCommand } from "@/modules/workflows/operator-command-policy";
import {
  enqueueOperatorCommand,
  requeueOperatorCommand,
} from "@/modules/workflows/operator-command-queue";

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
  try {
    const enqueued = await enqueueOperatorCommand(getDatabase(), {
      command: input.command,
      payload: input.payload,
      requestedBy: input.actor,
      dedupeKey: input.dedupeKey,
    });
    return destination(
      request,
      input.returnTo,
      enqueued.duplicate
        ? `${input.label} is already queued`
        : `${input.label} queued — it runs on the next maintenance pass`,
    );
  } catch {
    return destination(request, input.returnTo, `${input.label} not queued`);
  }
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
      },
    });
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
    return destination(
      request,
      uuidSchema.safeParse(campaignId).success
        ? `/campaigns/${campaignId}`
        : "/campaigns",
      result.ok
        ? result.disposition === "existing"
          ? "Contact already enrolled"
          : "Contact enrolled — their first message is queued for the next maintenance pass"
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
      return destination(
        request,
        "/review",
        sendOutcomeNotice(await recordedSendOutcome(dispatched.runId)),
      );
    } catch {
      return destination(request, "/review", "Send execution failed safely");
    }
  }

  if (command === "retry-command") {
    const commandId = value(formData, "commandId");
    if (!uuidSchema.safeParse(commandId).success) {
      return destination(request, "/outbound", "Invalid command");
    }
    const requeued = await requeueOperatorCommand(db, { id: commandId! });
    return destination(
      request,
      "/outbound",
      requeued
        ? "Queued again — it runs on the next maintenance pass"
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
      dedupeKey: `ui:inbound-sync:${mailboxId}:${randomUUID()}`,
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
