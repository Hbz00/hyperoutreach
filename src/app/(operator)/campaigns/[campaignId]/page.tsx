import { and, asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDatabase } from "@/lib/db/client";
import {
  campaigns,
  campaignVersions,
  contacts,
  emailCandidates,
  enrollments,
  mailboxConnections,
  sequenceSteps,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { readPersonalizationDeclaration } from "@/modules/messages/personalization-declaration";
import { StatusBadge } from "@/modules/presentation/status-badge";
import { describeStopReason } from "@/modules/presentation/status";

/**
 * What a stored step already asks the agent to write, read through the tree's
 * one answer to that question rather than a private copy of the shape check.
 * The helper says it is the single reader, and two copies here made that false.
 */
function declaredFields(step: { personalizationSchema: unknown }): string[] {
  return (
    readPersonalizationDeclaration(step.personalizationSchema)?.fields ?? []
  );
}

function minConfidence(step: { personalizationSchema: unknown }): number {
  return (
    readPersonalizationDeclaration(step.personalizationSchema)?.minConfidence ??
    0.5
  );
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { campaignId } = await params;
  const { notice } = await searchParams;
  const db = getDatabase();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) notFound();
  const versions = await db
    .select()
    .from(campaignVersions)
    .where(eq(campaignVersions.campaignId, campaign.id))
    .orderBy(desc(campaignVersions.version));
  const activeVersion = versions[0]!;
  const enrollmentVersion =
    versions.find((version) => version.publishedAt) ?? activeVersion;
  const steps = await db
    .select()
    .from(sequenceSteps)
    .where(eq(sequenceSteps.campaignVersionId, activeVersion.id))
    .orderBy(asc(sequenceSteps.stepIndex));
  const prospects = await db
    .select({
      id: contacts.id,
      name: contacts.fullName,
      email: emailCandidates.normalizedEmail,
    })
    .from(contacts)
    .innerJoin(
      emailCandidates,
      and(
        eq(emailCandidates.contactId, contacts.id),
        eq(emailCandidates.status, "accepted"),
      ),
    )
    .orderBy(asc(contacts.fullName));
  const mailboxes = await db
    .select({
      id: mailboxConnections.id,
      email: mailboxConnections.email,
      provider: mailboxConnections.provider,
      status: mailboxConnections.status,
    })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.status, "available"));
  const enrollmentRows = await db
    .select({
      id: enrollments.id,
      contact: contacts.fullName,
      state: enrollments.state,
      step: enrollments.currentStep,
      next: enrollments.nextActionAt,
      stopReason: enrollments.stopReason,
      campaignVersionId: enrollments.campaignVersionId,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .where(eq(enrollments.campaignId, campaign.id))
    .orderBy(desc(enrollments.createdAt));
  const config = activeVersion.configuration as Record<string, unknown>;
  const drafting = !activeVersion.publishedAt;
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Campaign · v{activeVersion.version}</p>
          <h1>{campaign.name}</h1>
          <p className="muted">{campaign.targetDescription}</p>
        </div>
        <div className="header-actions">
          <StatusBadge kind="campaign" value={campaign.status} />
          {campaign.status === "active" ? (
            <form action="/api/operator/commands/pause-campaign" method="post">
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="campaignId" value={campaign.id} />
              <button className="button-secondary">Pause</button>
            </form>
          ) : campaign.status === "paused" ? (
            <form action="/api/operator/commands/resume-campaign" method="post">
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="campaignId" value={campaign.id} />
              <button>Resume</button>
            </form>
          ) : null}
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}

      {drafting ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Publish version {activeVersion.version}</h2>
              <p className="muted">
                Publishing makes this sequence available for enrollment. Once
                used, it can never change — revisions create a new version.
              </p>
            </div>
            <form
              action="/api/operator/commands/publish-campaign"
              method="post"
            >
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input
                type="hidden"
                name="campaignVersionId"
                value={activeVersion.id}
              />
              <button>Publish version {activeVersion.version}</button>
            </form>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>Enroll a prospect</h2>
        {prospects.length === 0 ? (
          <p className="hint">
            No prospect has an accepted email yet. Resolve one on the{" "}
            <Link href="/prospects">Prospects page</Link> first.
          </p>
        ) : null}
        {!enrollmentVersion.publishedAt ? (
          <p className="hint">Publish the sequence before enrolling.</p>
        ) : null}
        <form
          action="/api/operator/commands/enroll-contact"
          method="post"
          className="form-grid"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input
            type="hidden"
            name="campaignVersionId"
            value={enrollmentVersion.id}
          />
          <label>
            Prospect
            <select name="contactId" required>
              <option value="">Select prospect</option>
              {prospects.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name} · {contact.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mailbox
            <select name="mailboxId" required>
              <option value="">Select mailbox</option>
              {mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.email} · {mailbox.provider}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!enrollmentVersion.publishedAt}>
            Enroll contact
          </button>
        </form>
        <p className="muted">
          Enrolling queues the first message; it appears in the review queue
          once written. Nothing is sent without your approval.
        </p>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Enrollments</h2>
          <span className="muted">{enrollmentRows.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>State</th>
                <th>Version</th>
                <th>Step</th>
                <th>Next action</th>
                <th>Stopped because</th>
              </tr>
            </thead>
            <tbody>
              {enrollmentRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.contact}</td>
                  <td>
                    <StatusBadge kind="enrollment" value={row.state} />
                  </td>
                  <td>
                    v
                    {versions.find(
                      (version) => version.id === row.campaignVersionId,
                    )?.version ?? "?"}
                  </td>
                  <td>{row.step + 1}</td>
                  <td>{row.next?.toLocaleString() ?? "—"}</td>
                  <td>
                    {row.stopReason ? describeStopReason(row.stopReason) : "—"}
                  </td>
                </tr>
              ))}
              {enrollmentRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No enrollments yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <details className="panel" open={drafting}>
        <summary>
          {drafting ? "Edit draft sequence" : "Revise sequence"}
          <small className="muted">
            {drafting
              ? "not published yet — edits stay on this draft"
              : `saving creates draft v${activeVersion.version + 1}`}
          </small>
        </summary>
        <form
          action="/api/operator/commands/revise-campaign"
          method="post"
          className="stack"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input
            type="hidden"
            name="campaignVersionId"
            value={activeVersion.id}
          />
          <div className="form-grid">
            <label>
              Daily cap
              <input
                name="campaignDailyCap"
                type="number"
                min={1}
                defaultValue={Number(config.campaignDailyCap ?? 50)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="automaticFollowUps"
                defaultChecked={config.automaticFollowUps === true}
              />
              Automatic follow-ups
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="holdNonTerminalReplies"
                defaultChecked={config.holdNonTerminalReplies === true}
              />
              Hold on unclear replies
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="requireProfessionalRelevance"
                defaultChecked={config.requireProfessionalRelevance === true}
              />
              Require professional relevance
            </label>
          </div>
          {steps.map((step) => (
            <fieldset key={step.id}>
              <legend>Step {step.stepIndex + 1}</legend>
              <div className="form-grid">
                <label>
                  Delay minutes
                  <input
                    name={`step${step.stepIndex}DelayMinutes`}
                    type="number"
                    min={0}
                    defaultValue={step.delayMinutes}
                  />
                </label>
                <label>
                  Subject
                  <input
                    name={`step${step.stepIndex}Subject`}
                    defaultValue={step.subjectTemplate}
                  />
                </label>
                <label className="span-all">
                  Body
                  <textarea
                    name={`step${step.stepIndex}Body`}
                    rows={4}
                    defaultValue={step.bodyTemplate}
                  />
                </label>
                <label className="span-all check">
                  <input
                    type="checkbox"
                    name={`step${step.stepIndex}AiOpening`}
                    defaultChecked={declaredFields(step).includes(
                      "personalized_opening",
                    )}
                  />
                  AI-written opening sentence — reference it as{" "}
                  <code>{"{{personalized_opening}}"}</code>
                </label>
                <label className="span-all check">
                  <input
                    type="checkbox"
                    name={`step${step.stepIndex}AiRelevance`}
                    defaultChecked={declaredFields(step).includes(
                      "company_relevance",
                    )}
                  />
                  AI-written company relevance — reference it as{" "}
                  <code>{"{{company_relevance}}"}</code>
                </label>
                <label>
                  Minimum AI confidence
                  <input
                    name={`step${step.stepIndex}MinConfidence`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={minConfidence(step)}
                  />
                </label>
                {/* The consequence of ticking either box on a follow-up, said
                    where the decision is made. The follow-up path hands a step
                    that declares an agent field to the command queue and parks
                    the prospect in the review queue — it cannot generate it in
                    the loop, because that loop runs once per due prospect and
                    there is one ChatGPT window. So this genuinely overrides
                    "Automatic follow-ups" for this step, and an operator who
                    only reads the checkbox above would never find that out. */}
                {step.stepIndex > 0 &&
                declaredFields(step).length > 0 &&
                config.automaticFollowUps === true ? (
                  <p className="muted span-all">
                    This step asks the agent for a sentence, so it will not go
                    out on its own: it is written on a maintenance pass and
                    waits for you in the review queue, even with automatic
                    follow-ups on.
                  </p>
                ) : null}
              </div>
            </fieldset>
          ))}
          <button type="submit">
            {drafting ? "Save draft" : "Create next version"}
          </button>
        </form>
      </details>

      <details className="panel">
        <summary>Version history</summary>
        {versions.map((version) => (
          <p key={version.id}>
            v{version.version} ·{" "}
            {version.publishedAt
              ? `published ${version.publishedAt.toLocaleString()}`
              : "draft"}
            {version.usedAt
              ? ` · first used ${version.usedAt.toLocaleString()}`
              : ""}
          </p>
        ))}
      </details>
    </main>
  );
}
