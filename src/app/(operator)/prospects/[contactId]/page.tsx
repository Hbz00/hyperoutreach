import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  agentRuns,
  campaigns,
  contacts,
  emailCandidates,
  enrollments,
  evidenceSources,
  messages,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";

function percent(value: string | null): string {
  return value ? `${Math.round(Number(value) * 100)}%` : "—";
}
function json(value: unknown): string {
  return value ? JSON.stringify(value, null, 2) : "No stored snapshot";
}

export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ contactId: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { contactId } = await params;
  const { notice } = await searchParams;
  const db = getDatabase();
  const [row] = await db
    .select({ contact: contacts, account: accounts })
    .from(contacts)
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) notFound();
  const [
    candidates,
    evidence,
    enrollmentRows,
    messageRows,
    transitions,
    workflows,
    runs,
  ] = await Promise.all([
    db
      .select()
      .from(emailCandidates)
      .where(eq(emailCandidates.contactId, contactId))
      .orderBy(desc(emailCandidates.confidence)),
    db
      .select()
      .from(evidenceSources)
      .where(eq(evidenceSources.contactId, contactId))
      .orderBy(desc(evidenceSources.retrievedAt)),
    db
      .select({ enrollment: enrollments, campaign: campaigns })
      .from(enrollments)
      .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
      .where(eq(enrollments.contactId, contactId))
      .orderBy(desc(enrollments.createdAt)),
    db
      .select()
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(eq(enrollments.contactId, contactId))
      .orderBy(desc(messages.createdAt)),
    db
      .select()
      .from(stateTransitions)
      .where(eq(stateTransitions.entityId, contactId))
      .orderBy(desc(stateTransitions.createdAt))
      .limit(30),
    db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.entityId, contactId))
      .orderBy(desc(workflowEvents.createdAt))
      .limit(30),
    db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(25),
  ]);
  const accountEvidence = await db
    .select()
    .from(evidenceSources)
    .where(eq(evidenceSources.accountId, row.account.id))
    .orderBy(desc(evidenceSources.retrievedAt));
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Prospect detail</p>
          <h1>{row.contact.fullName}</h1>
          <p className="muted">
            {row.contact.jobTitle ?? "Role unknown"} at {row.account.name}
          </p>
        </div>
        <Link className="button-link" href="/prospects">
          Back to prospects
        </Link>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      <section className="detail-grid">
        <article className="panel">
          <h2>Identity & lifecycle</h2>
          <dl className="facts">
            <div>
              <dt>Contact state</dt>
              <dd>{row.contact.status}</dd>
            </div>
            <div>
              <dt>Research</dt>
              <dd>{row.account.researchStatus}</dd>
            </div>
            <div>
              <dt>Email resolution</dt>
              <dd>{row.contact.emailResolutionStatus}</dd>
            </div>
            <div>
              <dt>Resolution reason</dt>
              <dd>{row.contact.emailResolutionReason ?? "—"}</dd>
            </div>
            <div>
              <dt>Company domain</dt>
              <dd>{row.account.domain ?? "—"}</dd>
            </div>
            <div>
              <dt>LinkedIn</dt>
              <dd>
                {row.contact.linkedinUrl ? (
                  <a href={row.contact.linkedinUrl}>
                    {row.contact.linkedinUrl}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        </article>
        <article className="panel">
          <h2>Research controls</h2>
          <div className="button-stack">
            <form
              action="/api/operator/commands/research-account"
              method="post"
            >
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="accountId" value={row.account.id} />
              <input
                type="hidden"
                name="returnTo"
                value={`/prospects/${contactId}`}
              />
              <input
                type="hidden"
                name="requestToken"
                value={crypto.randomUUID()}
              />
              <label className="check">
                <input type="checkbox" name="force" />
                Force fresh research
              </label>
              <button>Research account</button>
            </form>
            <form
              action="/api/operator/commands/discover-contacts"
              method="post"
            >
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="accountId" value={row.account.id} />
              <input
                type="hidden"
                name="returnTo"
                value={`/prospects/${contactId}`}
              />
              <input
                type="hidden"
                name="requestToken"
                value={crypto.randomUUID()}
              />
              <label>
                Target roles
                <input
                  name="roles"
                  defaultValue={
                    row.contact.jobTitle ?? "Founder, Head of Product"
                  }
                />
              </label>
              <label>
                Limit
                <input
                  name="limit"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={10}
                />
              </label>
              <button className="button-secondary">Discover coworkers</button>
            </form>
            <form action="/api/operator/commands/resolve-email" method="post">
              <input type="hidden" name="csrf" value={session.csrfToken} />
              <input type="hidden" name="contactId" value={contactId} />
              <input
                type="hidden"
                name="requestToken"
                value={crypto.randomUUID()}
              />
              <label>
                Confidence threshold
                <input
                  name="confidenceThreshold"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  defaultValue="0.85"
                />
              </label>
              <button className="button-secondary">Resolve email</button>
            </form>
          </div>
        </article>
      </section>
      <section className="panel">
        <h2>Accepted email & inference</h2>
        <form
          action="/api/operator/commands/accept-manual-email"
          method="post"
          className="inline-form"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <input type="hidden" name="contactId" value={contactId} />
          <label>
            Operator-provided address
            <input
              type="email"
              name="email"
              placeholder={`first.last@${row.account.domain ?? "company.com"}`}
              required
            />
          </label>
          <button>Accept address</button>
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Pattern/source</th>
                <th>Confidence</th>
                <th>MX</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td>{candidate.normalizedEmail}</td>
                  <td>
                    {candidate.pattern ?? "manual"}
                    <small>{candidate.source}</small>
                  </td>
                  <td>{percent(candidate.confidence)}</td>
                  <td>
                    {candidate.mxValid === null
                      ? "Not checked"
                      : candidate.mxValid
                        ? "Present"
                        : "Missing"}
                  </td>
                  <td>
                    <span className="badge">{candidate.status}</span>
                  </td>
                </tr>
              ))}
              {candidates.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No candidates yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Company research snapshot</h2>
        <pre className="json-block">{json(row.account.researchSnapshot)}</pre>
        <h3>Sources & provenance</h3>
        <div className="evidence-list">
          {[...accountEvidence, ...evidence].map((source) => (
            <article key={source.id}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title ?? source.url}
              </a>
              <span>
                {source.sourceType} · {percent(source.confidence)} · fetched{" "}
                {source.retrievedAt.toLocaleString()}
              </span>
              <code>{(source.supports as string[]).join(", ")}</code>
            </article>
          ))}
          {accountEvidence.length + evidence.length === 0 ? (
            <p className="empty">No evidence has been stored.</p>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <h2>Enrollments & message history</h2>
        {enrollmentRows.map(({ enrollment, campaign }) => (
          <article
            className="timeline-card"
            key={enrollment.id}
            data-enrollment-id={enrollment.id}
          >
            <div>
              <strong>{campaign.name}</strong>
              <span className="badge">{enrollment.state}</span>
              <p>
                Step {enrollment.currentStep + 1} · next{" "}
                {enrollment.nextActionAt?.toLocaleString() ?? "none"} · stop{" "}
                {enrollment.stopReason ?? "none"}
              </p>
            </div>
            {[
              "ready_for_review",
              "approved",
              "active",
              "waiting",
              "manual_review",
              "paused",
              "failed",
            ].includes(enrollment.state) ? (
              <div className="header-actions">
                <form
                  action="/api/operator/commands/generate-message"
                  method="post"
                >
                  <input type="hidden" name="csrf" value={session.csrfToken} />
                  <input
                    type="hidden"
                    name="enrollmentId"
                    value={enrollment.id}
                  />
                  <input
                    type="hidden"
                    name="stepIndex"
                    value={enrollment.currentStep}
                  />
                  <button>Generate step {enrollment.currentStep + 1}</button>
                </form>
                <form
                  action="/api/operator/commands/stop-enrollment"
                  method="post"
                >
                  <input type="hidden" name="csrf" value={session.csrfToken} />
                  <input
                    type="hidden"
                    name="enrollmentId"
                    value={enrollment.id}
                  />
                  <input
                    type="hidden"
                    name="returnTo"
                    value={`/prospects/${contactId}`}
                  />
                  <button className="button-danger">Stop</button>
                </form>
              </div>
            ) : null}
          </article>
        ))}
        {enrollmentRows.length === 0 ? (
          <p className="empty">Not enrolled in a campaign.</p>
        ) : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Direction/step</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {messageRows.map(({ messages: message }) => (
                <tr key={message.id}>
                  <td>{message.createdAt.toLocaleString()}</td>
                  <td>
                    {message.direction} ·{" "}
                    {message.stepIndex === null ? "—" : message.stepIndex + 1}
                  </td>
                  <td>
                    <details>
                      <summary>{message.subject}</summary>
                      <pre className="message-body">{message.body}</pre>
                    </details>
                  </td>
                  <td>
                    <span className="badge">{message.status}</span>
                  </td>
                  <td>{message.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <details className="panel">
        <summary>Operational audit</summary>
        <h3>State transitions</h3>
        {transitions.map((item) => (
          <pre key={item.id} className="audit-row">
            {item.createdAt.toISOString()} {item.fromState ?? "∅"} →{" "}
            {item.toState} · {item.reason}
          </pre>
        ))}
        <h3>Workflow events for this contact</h3>
        {workflows.map((item) => (
          <pre key={item.id} className="audit-row">
            {item.createdAt.toISOString()} {item.workflowName} · {item.status} ·
            attempt {item.attempt} {item.error ?? ""}
          </pre>
        ))}
        <h3>Recent agent runs</h3>
        {runs.map((run) => (
          <pre key={run.id} className="audit-row">
            {run.createdAt.toISOString()} {run.agent} · {run.model} ·{" "}
            {run.status} · {run.promptVersion}/{run.schemaVersion} · tokens{" "}
            {JSON.stringify(run.tokenUsage)} · cost{" "}
            {run.costAvailability === "available" ? run.costUsd : "unavailable"}{" "}
            {run.error ?? ""}
          </pre>
        ))}
      </details>
    </main>
  );
}
