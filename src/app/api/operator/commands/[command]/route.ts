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
import {
  contacts,
  emailCandidates,
  enrollments,
  mailboxConnections,
  messages,
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
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";
import { disconnectMicrosoftMailbox } from "@/modules/mailboxes/microsoft-oauth-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { createReplyClassifier } from "@/modules/replies/classifier-factory";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { updateOperatorSendingSettings } from "@/modules/settings/service";
import {
  addSuppression,
  removeSuppression,
} from "@/modules/suppression/service";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";

export const runtime = "nodejs";
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

function campaignSteps(formData: FormData) {
  const steps = [];
  for (let index = 0; index < 20; index += 1) {
    const subjectTemplate = value(formData, `step${index}Subject`);
    const bodyTemplate = value(formData, `step${index}Body`);
    if (!subjectTemplate && !bodyTemplate) continue;
    steps.push({
      delayMinutes: integer(formData, `step${index}DelayMinutes`) ?? 0,
      subjectTemplate: subjectTemplate ?? "",
      bodyTemplate: bodyTemplate ?? "",
    });
  }
  return steps;
}

async function acceptedRecipient(enrollmentId: string) {
  const [row] = await getDatabase()
    .select({ email: emailCandidates.normalizedEmail })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(
      emailCandidates,
      and(
        eq(emailCandidates.contactId, contacts.id),
        eq(emailCandidates.status, "accepted"),
      ),
    )
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);
  return row?.email ?? null;
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
    try {
      const result = await createWorkflowDispatcher().dispatch({
        task: "account-discovery",
        payload: {
          icp,
          limit,
          countries: list(formData, "countries"),
          industries: list(formData, "industries"),
          requiredSignals: list(formData, "requiredSignals"),
        },
        idempotencyKey: `ui:account-discovery:${value(formData, "requestToken") ?? randomUUID()}`,
      });
      return destination(
        request,
        "/prospects",
        result.duplicate ? "Discovery already queued" : "Discovery executed",
      );
    } catch {
      return destination(request, "/prospects", "Discovery failed safely");
    }
  }

  if (command === "research-account") {
    const accountId = value(formData, "accountId");
    if (!uuidSchema.safeParse(accountId).success) {
      return destination(request, "/prospects", "Invalid account");
    }
    try {
      await createWorkflowDispatcher().dispatch({
        task: "account-research",
        payload: { accountId: accountId!, force: boolean(formData, "force") },
        idempotencyKey: `ui:account-research:${accountId}:${value(formData, "requestToken") ?? randomUUID()}`,
      });
      return destination(
        request,
        value(formData, "returnTo") ?? "/prospects",
        "Account research executed",
      );
    } catch {
      return destination(
        request,
        value(formData, "returnTo") ?? "/prospects",
        "Account research failed safely",
      );
    }
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
    try {
      await createWorkflowDispatcher().dispatch({
        task: "contact-discovery",
        payload: {
          accountId: accountId!,
          roles,
          limit: integer(formData, "limit") ?? 10,
        },
        idempotencyKey: `ui:contact-discovery:${accountId}:${value(formData, "requestToken") ?? randomUUID()}`,
      });
      return destination(
        request,
        value(formData, "returnTo") ?? "/prospects",
        "Contact discovery executed",
      );
    } catch {
      return destination(
        request,
        value(formData, "returnTo") ?? "/prospects",
        "Contact discovery failed safely",
      );
    }
  }

  if (command === "resolve-email") {
    const contactId = value(formData, "contactId");
    if (!uuidSchema.safeParse(contactId).success) {
      return destination(request, "/prospects", "Invalid contact");
    }
    try {
      await createWorkflowDispatcher().dispatch({
        task: "email-resolution",
        payload: {
          contactId: contactId!,
          confidenceThreshold: Number(
            value(formData, "confidenceThreshold") ?? "0.85",
          ),
        },
        idempotencyKey: `ui:email-resolution:${contactId}:${value(formData, "requestToken") ?? randomUUID()}`,
      });
      return destination(
        request,
        `/prospects/${contactId}`,
        "Email resolution executed",
      );
    } catch {
      return destination(
        request,
        `/prospects/${contactId}`,
        "Email resolution failed safely",
      );
    }
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
        reviewMode: value(formData, "reviewMode") ?? "manual",
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
        reviewMode: value(formData, "reviewMode") ?? "manual",
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
          : "Contact enrolled"
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
    const recipient = await acceptedRecipient(enrollmentId!);
    if (!recipient)
      return destination(
        request,
        "/review",
        "No accepted email for this contact",
      );
    try {
      await createWorkflowDispatcher().dispatch({
        task: "generate-message",
        payload: { enrollmentId: enrollmentId!, stepIndex, recipient },
        idempotencyKey: `ui:generate:${enrollmentId}:${stepIndex}`,
      });
      return destination(request, "/review", "Message generated");
    } catch {
      return destination(
        request,
        "/review",
        "Message generation failed safely",
      );
    }
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
      await createWorkflowDispatcher().dispatch({
        task: "send-approved-message",
        payload: { messageId: messageId! },
        idempotencyKey: `ui:send:${messageId}`,
      });
      return destination(request, "/review", "Send execution completed");
    } catch {
      return destination(request, "/review", "Send execution failed safely");
    }
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
    const result = await ingestInboundMessage(db, createReplyClassifier(), {
      mailboxId: outbound.mailbox.id,
      providerMessageId: `mock_reply_${randomUUID()}`,
      outreachId: outbound.message.outreachId ?? undefined,
      conversationId: outbound.message.conversationId ?? undefined,
      inReplyTo: outbound.message.internetMessageId ?? undefined,
      sender: outbound.message.recipient,
      recipient: outbound.mailbox.email,
      subject: value(formData, "subject") ?? `Re: ${outbound.message.subject}`,
      body: value(formData, "body") ?? "",
      receivedAt: new Date(),
      metadata: { injectedBy: session.email },
    });
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
    try {
      await createWorkflowDispatcher().dispatch({
        task: "reconcile-graph-delta",
        payload: { mailboxId: mailboxId! },
        idempotencyKey: `ui:graph-delta:${mailboxId}:${randomUUID()}`,
      });
      return destination(request, "/settings", "Mailbox sync executed");
    } catch {
      return destination(request, "/settings", "Mailbox sync failed safely");
    }
  }

  if (command === "disconnect-mailbox") {
    const mailboxId = value(formData, "mailboxId");
    if (!uuidSchema.safeParse(mailboxId).success)
      return destination(request, "/settings", "Invalid mailbox");
    try {
      const result = await disconnectMicrosoftMailbox(db, mailboxId!);
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
