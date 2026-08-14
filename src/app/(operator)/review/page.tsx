import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  campaigns,
  contacts,
  enrollments,
  emailCandidates,
  evidenceSources,
  messages,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const rows = await getDatabase()
    .select({
      message: messages,
      enrollment: enrollments,
      contact: contacts,
      account: accounts,
      campaign: campaigns,
      acceptedEmail: emailCandidates,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(accounts, eq(accounts.id, messages.contactAccountId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .leftJoin(
      emailCandidates,
      and(
        eq(emailCandidates.contactId, contacts.id),
        eq(emailCandidates.normalizedEmail, sql`lower(${messages.recipient})`),
      ),
    )
    .where(
      inArray(messages.status, [
        "proposed",
        "approved",
        "draft_creating",
        "drafted",
        "sending",
        "delivery_uncertain",
        "failed",
      ]),
    )
    .orderBy(asc(messages.createdAt));
  const accountIds = [...new Set(rows.map((row) => row.account.id))];
  const contactIds = [...new Set(rows.map((row) => row.contact.id))];
  const evidence =
    accountIds.length || contactIds.length
      ? await getDatabase()
          .select()
          .from(evidenceSources)
          .where(
            or(
              accountIds.length
                ? inArray(evidenceSources.accountId, accountIds)
                : undefined,
              contactIds.length
                ? inArray(evidenceSources.contactId, contactIds)
                : undefined,
            ),
          )
          .orderBy(desc(evidenceSources.retrievedAt))
      : [];
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Human-in-the-loop</p>
          <h1>Review queue</h1>
          <p className="muted">
            The persisted subject and body below are exactly what the send
            service receives.
          </p>
        </div>
        <form action="/api/operator/commands/reconcile-followups" method="post">
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <button className="button-secondary">Process due follow-ups</button>
        </form>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      <section className="review-list">
        {rows.map((row) => {
          const bindingFresh =
            row.message.contactAccountId === row.contact.accountId &&
            row.message.employmentVersion === row.contact.employmentVersion &&
            row.acceptedEmail?.status === "accepted" &&
            row.contact.emailResolutionStatus === "resolved" &&
            ![
              "replied",
              "opted_out",
              "bounced",
              "stopped",
              "completed",
            ].includes(row.enrollment.state);
          const sources = evidence.filter(
            (item) =>
              item.accountId === row.account.id ||
              item.contactId === row.contact.id,
          );
          return (
            <article className="review-card" key={row.message.id}>
              <header>
                <div>
                  <p className="eyebrow">
                    {row.campaign.name} · step{" "}
                    {(row.message.stepIndex ?? 0) + 1}
                  </p>
                  <h2>
                    {row.contact.fullName} · {row.account.name}
                  </h2>
                  <p className="muted">
                    {row.contact.jobTitle ?? "Role unknown"} ·{" "}
                    {row.message.recipient}
                  </p>
                  <Link href={`/prospects/${row.contact.id}`}>
                    Open prospect evidence
                  </Link>
                </div>
                <span className="badge">{row.message.status}</span>
              </header>
              <div className="review-grid">
                <form
                  action="/api/operator/commands/review-message"
                  method="post"
                  className="stack"
                >
                  <input type="hidden" name="csrf" value={session.csrfToken} />
                  <input
                    type="hidden"
                    name="messageId"
                    value={row.message.id}
                  />
                  <label>
                    Subject
                    <input
                      name="subject"
                      defaultValue={row.message.subject}
                      readOnly={row.message.status !== "proposed"}
                    />
                  </label>
                  <label>
                    Body
                    <textarea
                      name="body"
                      rows={10}
                      defaultValue={row.message.body}
                      readOnly={row.message.status !== "proposed"}
                    />
                  </label>
                  <div className="header-actions">
                    {row.message.status === "proposed" && bindingFresh ? (
                      <>
                        <button name="reviewAction" value="approve">
                          Approve
                        </button>
                        <button
                          name="reviewAction"
                          value="edit_and_approve"
                          className="button-secondary"
                        >
                          Save edit & approve
                        </button>
                        <button
                          name="reviewAction"
                          value="reject"
                          className="button-danger"
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                  </div>
                  {row.message.status === "proposed" ? (
                    <label>
                      Rejection reason
                      <input
                        name="reason"
                        placeholder="Why should this message not be sent?"
                      />
                    </label>
                  ) : null}
                </form>
                <aside>
                  <h3>Evidence & confidence</h3>
                  <dl className="facts">
                    <div>
                      <dt>Enrollment</dt>
                      <dd>
                        {row.enrollment.state} · stop{" "}
                        {row.enrollment.stopReason ?? "none"}
                      </dd>
                    </div>
                    <div>
                      <dt>Message binding</dt>
                      <dd>
                        {bindingFresh ? "Current" : "Stale — approval disabled"}
                      </dd>
                    </div>
                    <div>
                      <dt>Research</dt>
                      <dd>{row.account.researchStatus}</dd>
                    </div>
                    <div>
                      <dt>Email resolution</dt>
                      <dd>
                        {row.contact.emailResolutionStatus} ·{" "}
                        {row.acceptedEmail
                          ? `${Math.round(Number(row.acceptedEmail.confidence) * 100)}% (${row.acceptedEmail.source}, ${row.acceptedEmail.status})`
                          : "no accepted candidate"}
                      </dd>
                    </div>
                    <div>
                      <dt>Employment version</dt>
                      <dd>{row.contact.employmentVersion}</dd>
                    </div>
                    <div>
                      <dt>Personalization</dt>
                      <dd>
                        Deterministic template fields only; no AI reasoning
                        field was requested for this step.
                      </dd>
                    </div>
                  </dl>
                  <form
                    action="/api/operator/commands/research-account"
                    method="post"
                  >
                    <input
                      type="hidden"
                      name="csrf"
                      value={session.csrfToken}
                    />
                    <input
                      type="hidden"
                      name="accountId"
                      value={row.account.id}
                    />
                    <input type="hidden" name="force" value="true" />
                    <input
                      type="hidden"
                      name="requestToken"
                      value={crypto.randomUUID()}
                    />
                    <input type="hidden" name="returnTo" value="/review" />
                    <button className="button-secondary">Research again</button>
                  </form>
                  <div className="evidence-list compact">
                    {sources.slice(0, 6).map((source) => (
                      <article key={source.id}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.title ?? source.url}
                        </a>
                        <span>
                          {source.sourceType} · confidence{" "}
                          {source.confidence ?? "—"}
                        </span>
                      </article>
                    ))}
                    {sources.length === 0 ? (
                      <p className="empty">No account evidence stored.</p>
                    ) : null}
                  </div>
                </aside>
              </div>
              {row.message.status === "approved" && bindingFresh ? (
                <form
                  action="/api/operator/commands/send-message"
                  method="post"
                >
                  <input type="hidden" name="csrf" value={session.csrfToken} />
                  <input
                    type="hidden"
                    name="messageId"
                    value={row.message.id}
                  />
                  <input
                    type="hidden"
                    name="requestToken"
                    value={crypto.randomUUID()}
                  />
                  <button>Send approved message</button>
                </form>
              ) : null}
              {row.message.lastError ? (
                <p className="alert alert-error">{row.message.lastError}</p>
              ) : null}
            </article>
          );
        })}
        {rows.length === 0 ? (
          <section className="panel empty">Review queue is clear.</section>
        ) : null}
      </section>
    </main>
  );
}
