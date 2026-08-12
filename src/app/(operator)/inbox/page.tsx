import { and, desc, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  campaigns,
  contacts,
  enrollments,
  inboundRecords,
  mailboxConnections,
  messages,
  replies,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const db = getDatabase();
  const rows = await db
    .select({
      reply: replies,
      inbound: inboundRecords,
      message: messages,
      enrollment: enrollments,
      contact: contacts,
      campaign: campaigns,
    })
    .from(replies)
    .innerJoin(inboundRecords, eq(inboundRecords.id, replies.inboundRecordId))
    .leftJoin(messages, eq(messages.id, replies.messageId))
    .leftJoin(enrollments, eq(enrollments.id, replies.enrollmentId))
    .leftJoin(contacts, eq(contacts.id, enrollments.contactId))
    .leftJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .orderBy(desc(replies.receivedAt));
  const sent = await db
    .select({ message: messages, contact: contacts })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(
      mailboxConnections,
      eq(mailboxConnections.id, messages.mailboxId),
    )
    .where(
      and(eq(messages.status, "sent"), eq(mailboxConnections.provider, "mock")),
    )
    .orderBy(desc(messages.sentAt))
    .limit(100);
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Inbound intelligence</p>
          <h1>Inbox & replies</h1>
          <p className="muted">
            Classifications, confidence, and deterministic sequence outcomes.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      {process.env.MAIL_PROVIDER !== "microsoft_graph" ? (
        <section className="panel">
          <h2>Inject a local reply</h2>
          <p className="muted">
            Mock-provider path through the same ingestion and classification
            service used by Graph.
          </p>
          <form
            action="/api/operator/commands/inject-reply"
            method="post"
            className="form-grid"
          >
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <label>
              Outbound message
              <select name="messageId" required>
                <option value="">Select sent message</option>
                {sent.map((row) => (
                  <option key={row.message.id} value={row.message.id}>
                    {row.contact.fullName} · {row.message.subject}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Subject
              <input name="subject" placeholder="Re: Your message" />
            </label>
            <label className="span-all">
              Body
              <textarea
                name="body"
                rows={4}
                required
                placeholder="Please unsubscribe me."
              />
            </label>
            <button>Ingest reply</button>
          </form>
        </section>
      ) : null}
      <section className="inbox-list">
        {rows.map((row) => (
          <article className="reply-card" key={row.reply.id}>
            <header>
              <div>
                <p className="eyebrow">{row.campaign?.name ?? "Unmatched"}</p>
                <h2>{row.reply.sender}</h2>
                <p className="muted">
                  {row.reply.subject} · {row.reply.receivedAt.toLocaleString()}
                </p>
              </div>
              <span className={`badge badge-${row.reply.classification}`}>
                {row.reply.classification}
              </span>
            </header>
            <p className="reply-body">{row.reply.body}</p>
            <dl className="facts">
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round(Number(row.reply.confidence) * 100)}%</dd>
              </div>
              <div>
                <dt>Classifier</dt>
                <dd>{row.reply.classifier}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{row.reply.classificationReason}</dd>
              </div>
              <div>
                <dt>Terminates sequence</dt>
                <dd>{row.reply.terminatesSequence ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>Enrollment</dt>
                <dd>{row.enrollment?.state ?? "Unmatched"}</dd>
              </div>
              <div>
                <dt>Stop reason</dt>
                <dd>{row.enrollment?.stopReason ?? "—"}</dd>
              </div>
            </dl>
          </article>
        ))}
        {rows.length === 0 ? (
          <section className="panel empty">No replies ingested yet.</section>
        ) : null}
      </section>
    </main>
  );
}
