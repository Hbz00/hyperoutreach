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
import { StatusBadge } from "@/modules/presentation/status-badge";
import {
  describeResolutionReason,
  describeStopReason,
} from "@/modules/presentation/status";

function percent(value: string | null): string {
  return value ? `${Math.round(Number(value) * 100)}%` : "—";
}

/** The persisted snapshot, read defensively: it is provider JSON. */
function snapshotFacts(snapshot: unknown): {
  summary: string | null;
  signals: { name: string; description: string }[];
} {
  const facts = (snapshot as { facts?: { summary?: unknown } } | null)?.facts;
  const summary =
    typeof facts?.summary === "string" && facts.summary.trim()
      ? facts.summary
      : null;
  const rawSignals = (snapshot as { signals?: unknown } | null)?.signals;
  const signals = Array.isArray(rawSignals)
    ? rawSignals.flatMap((signal) => {
        const name = (signal as { name?: unknown })?.name;
        const description = (signal as { description?: unknown })?.description;
        return typeof name === "string" && typeof description === "string"
          ? [{ name, description }]
          : [];
      })
    : [];
  return { summary, signals };
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
  const snapshot = snapshotFacts(row.account.researchSnapshot);
  const allEvidence = [...accountEvidence, ...evidence];
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Prospect detail</p>
          <h1>{row.contact.fullName}</h1>
          <p className="muted">
            {row.contact.jobTitle ?? "Role unknown"} at {row.account.name}
            {row.account.domain ? ` · ${row.account.domain}` : ""}
            {row.contact.linkedinUrl ? (
              <>
                {" · "}
                <a href={row.contact.linkedinUrl}>LinkedIn</a>
              </>
            ) : null}
          </p>
          <p>
            <StatusBadge kind="contact" value={row.contact.status} />{" "}
            <StatusBadge kind="research" value={row.account.researchStatus} />{" "}
            {/* Only as a problem signal: on the happy path the contact badge
                already says "Email resolved", and two identical badges read
                as a rendering bug. */}
            {row.contact.emailResolutionStatus !== "resolved" ? (
              <StatusBadge
                kind="emailResolution"
                value={row.contact.emailResolutionStatus}
              />
            ) : null}
          </p>
          {row.contact.emailResolutionStatus !== "resolved" &&
          row.contact.emailResolutionReason ? (
            <p className="muted">
              Why: {describeResolutionReason(row.contact.emailResolutionReason)}
            </p>
          ) : null}
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

      <section className="panel">
        <h2>Run research &amp; resolution</h2>
        <p className="muted">
          These queue on the maintenance pass and finish within minutes.
        </p>
        <div className="detail-grid">
          <form action="/api/operator/commands/research-account" method="post">
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
            <div className="stack">
              <label className="check">
                <input type="checkbox" name="force" />
                Force fresh research
              </label>
              <button>Research account</button>
            </div>
          </form>
          <form action="/api/operator/commands/resolve-email" method="post">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <input type="hidden" name="contactId" value={contactId} />
            <input
              type="hidden"
              name="requestToken"
              value={crypto.randomUUID()}
            />
            <div className="stack">
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
            </div>
          </form>
          <form action="/api/operator/commands/discover-contacts" method="post">
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
            <div className="stack">
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
            </div>
          </form>
        </div>
      </section>

      <section className="panel">
        <h2>Email</h2>
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
                    <StatusBadge
                      kind="emailCandidate"
                      value={candidate.status}
                    />
                  </td>
                </tr>
              ))}
              {candidates.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No candidates yet — run “Resolve email” above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <form
          action="/api/operator/commands/accept-manual-email"
          method="post"
          className="inline-form"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <input type="hidden" name="contactId" value={contactId} />
          <label>
            Know the address? Accept it manually
            <input
              type="email"
              name="email"
              placeholder={`first.last@${row.account.domain ?? "company.com"}`}
              required
            />
          </label>
          <button>Accept address</button>
        </form>
      </section>

      <section className="panel">
        <h2>Company research</h2>
        {snapshot.summary ? (
          <p>{snapshot.summary}</p>
        ) : row.account.researchSnapshot ? null : (
          <p className="empty">No research snapshot yet.</p>
        )}
        {snapshot.signals.length > 0 ? (
          <ul>
            {snapshot.signals.map((signal, index) => (
              <li key={`${index}-${signal.name}`}>
                <strong>{signal.name}</strong> — {signal.description}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="evidence-list">
          {allEvidence.map((source) => (
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
          {allEvidence.length === 0 ? (
            <p className="empty">No evidence has been stored.</p>
          ) : null}
        </div>
        {row.account.researchSnapshot ? (
          <details>
            <summary>Raw snapshot (JSON)</summary>
            <pre className="json-block">
              {JSON.stringify(row.account.researchSnapshot, null, 2)}
            </pre>
          </details>
        ) : null}
      </section>

      <section className="panel">
        <h2>Campaigns &amp; messages</h2>
        {enrollmentRows.map(({ enrollment, campaign }) => (
          <article
            className="timeline-card"
            key={enrollment.id}
            data-enrollment-id={enrollment.id}
          >
            <div>
              <strong>{campaign.name}</strong>{" "}
              <StatusBadge kind="enrollment" value={enrollment.state} />
              <p className="muted">
                Step {enrollment.currentStep + 1} · next{" "}
                {enrollment.nextActionAt?.toLocaleString() ?? "none"}
                {enrollment.stopReason
                  ? ` · stopped: ${describeStopReason(enrollment.stopReason)}`
                  : ""}
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
                  {/* One token per render, like every other queued command.
                      A deliberate second click is a new render and so a new
                      row; a resubmitted form is the same token and answers
                      "already queued" rather than spending a second turn on
                      the operator's ChatGPT window. */}
                  <input
                    type="hidden"
                    name="requestToken"
                    value={crypto.randomUUID()}
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
                    <StatusBadge kind="message" value={message.status} />
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
        {/* Every other block in this panel is filtered to this contact. This
            one cannot be: `agent_runs` records the agent, the model and the
            structured input, and carries no column tying a run to a contact or
            an account — a research run is about a company, a classification is
            about a reply. Saying "recent agent runs" beside a prospect's name
            read as this prospect's, which is how an operator concludes the
            wrong company was researched. The heading says what the rows are
            until the table can answer the narrower question. */}
        <h3>Recent agent runs, across the installation</h3>
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
