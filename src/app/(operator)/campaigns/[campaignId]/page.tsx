import { and, asc, desc, eq } from "drizzle-orm";
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

/** What a stored step already asks the agent to write. */
function declaredFields(step: { personalizationSchema: unknown }): string[] {
  const declared = step.personalizationSchema as { fields?: unknown };
  return Array.isArray(declared?.fields) ? (declared.fields as string[]) : [];
}

function minConfidence(step: { personalizationSchema: unknown }): number {
  const declared = step.personalizationSchema as { minConfidence?: unknown };
  return typeof declared?.minConfidence === "number"
    ? declared.minConfidence
    : 0.5;
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
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Campaign · v{activeVersion.version}</p>
          <h1>{campaign.name}</h1>
          <p className="muted">{campaign.targetDescription}</p>
        </div>
        <div className="header-actions">
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
      {activeVersion.publishedAt ? null : (
        <section className="panel">
          <h2>Publish current version</h2>
          <p className="muted">
            Publication makes this template set available for enrollment. Used
            versions become immutable.
          </p>
          <form action="/api/operator/commands/publish-campaign" method="post">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input
              type="hidden"
              name="campaignVersionId"
              value={activeVersion.id}
            />
            <button>Publish version {activeVersion.version}</button>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Sequence editor</h2>
          <span>{activeVersion.publishedAt ? "Published" : "Draft"}</span>
        </div>
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
              </div>
            </fieldset>
          ))}
          <button type="submit">
            {activeVersion.publishedAt ? "Create next version" : "Save draft"}
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Enroll a resolved prospect</h2>
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
      </section>
      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Enrollment state</h2>
          <span>{enrollmentRows.length}</span>
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
                <th>Stop reason</th>
              </tr>
            </thead>
            <tbody>
              {enrollmentRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.contact}</td>
                  <td>
                    <span className="badge">{row.state}</span>
                  </td>
                  <td>
                    v
                    {versions.find(
                      (version) => version.id === row.campaignVersionId,
                    )?.version ?? "?"}
                  </td>
                  <td>{row.step + 1}</td>
                  <td>{row.next?.toLocaleString() ?? "—"}</td>
                  <td>{row.stopReason ?? "—"}</td>
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
      <details className="panel">
        <summary>Immutable version history</summary>
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
