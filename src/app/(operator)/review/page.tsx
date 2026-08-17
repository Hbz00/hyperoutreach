import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  campaigns,
  contacts,
  emailCandidates,
  enrollments,
  evidenceSources,
  mailboxConnections,
  messagePersonalizationFields,
  messages,
  operatorCommands,
  operatorSendingSettings,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { StatusBadge } from "@/modules/presentation/status-badge";
import {
  describeStatus,
  describeStopReason,
} from "@/modules/presentation/status";
import { sendBlockNotice } from "@/modules/messages/send-block-notice";
import {
  scheduledInstantLabel,
  scheduleOfferLabel,
} from "@/modules/messages/scheduled-send";
import { readSendPolicyVerdict } from "@/modules/messages/send-service";
import { operatorClock } from "@/modules/settings/working-hours";

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
      mailboxProvider: mailboxConnections.provider,
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
    // Joined on the message's own mailbox, which is the column the send
    // service resolves its provider from. The enrollment's can drift from it.
    .leftJoin(mailboxConnections, eq(mailboxConnections.id, messages.mailboxId))
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
  const personalization = rows.length
    ? await getDatabase()
        .select()
        .from(messagePersonalizationFields)
        .where(
          inArray(
            messagePersonalizationFields.messageId,
            rows.map((row) => row.message.id),
          ),
        )
    : [];
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
  // "Would this go out right now?" is a different question from what
  // `lastError` answers, which is "what did the last attempt say?" — an
  // emergency pause lifted after a refusal leaves that older sentence behind.
  // Both are shown, each labelled for what it is.
  //
  // Only `approved` and `drafted` cards get a verdict: on a `proposed` card
  // the answer is always MESSAGE_NOT_APPROVED and says nothing. The check
  // costs about a dozen queries per card, which one operator reviewing a
  // handful of messages can afford, and it contacts nothing — it reads the
  // mailbox's provider kind rather than building a provider.
  // "Nothing to review" and "nothing has been written yet" are different
  // answers, and only one of them means the operator can stop looking.
  const [{ count: pendingGenerations = 0 } = { count: 0 }] = await getDatabase()
    .select({ count: sql<number>`count(*)::int` })
    .from(operatorCommands)
    .where(
      and(
        eq(operatorCommands.task, "generate-message"),
        inArray(operatorCommands.status, ["queued", "waiting", "running"]),
      ),
    );
  const now = new Date();
  const sendChecks = new Map<string, string>();
  // The label of the "schedule this" control per card, empty when there is
  // nothing to offer. The rule that decides it lives in `scheduleOfferLabel`,
  // where it can be tested.
  const scheduleOffers = new Map<string, string>();
  const [sendingSettings] = await getDatabase()
    .select()
    .from(operatorSendingSettings)
    .where(eq(operatorSendingSettings.id, 1))
    .limit(1);
  // A slot computed against a 09:00 calendar must not be announced as 07:00
  // UTC, which is what the schema column says about itself and what the send
  // notice already does. The card is the other place the operator reads it,
  // and it reads it through the same helper so the two cannot drift.
  const operatorInstant = (instant: Date | null) =>
    instant ? operatorClock(instant, sendingSettings?.timezone) : "—";
  for (const row of rows) {
    if (row.message.status !== "approved" && row.message.status !== "drafted") {
      continue;
    }
    const verdict = await readSendPolicyVerdict(
      getDatabase(),
      row.message.id,
      row.mailboxProvider ?? "mock",
      now,
    );
    if (!verdict) continue;
    sendChecks.set(
      row.message.id,
      verdict.ok
        ? "Would go out now"
        : `Held — ${sendBlockNotice(verdict.code)}`,
    );
    if (sendingSettings) {
      const offer = scheduleOfferLabel(verdict, now, sendingSettings, {
        alreadyScheduled: Boolean(row.message.scheduledAt),
        // The verdict is rendered for `drafted` cards too, and an intent can
        // only be written for an `approved` one. Offering on the other is a
        // button whose route answers "no longer waiting to be sent".
        schedulable: row.message.status === "approved",
      });
      if (offer) scheduleOffers.set(row.message.id, offer);
    }
  }
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Human-in-the-loop</p>
          <h1>Review queue</h1>
          <p className="muted">
            {rows.length === 0
              ? "Nothing waits on you."
              : `${rows.length} message${rows.length > 1 ? "s" : ""} — the subject and body shown are exactly what would be sent.`}
          </p>
        </div>
        <Link className="button-link" href="/outbound">
          See what goes out
        </Link>
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
          const written = personalization.filter(
            (field) => field.messageId === row.message.id,
          );
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
                <StatusBadge kind="message" value={row.message.status} />
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
                    {sendChecks.has(row.message.id) ? (
                      <div>
                        <dt>Send check</dt>
                        <dd>{sendChecks.get(row.message.id)}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Enrollment</dt>
                      <dd>
                        {
                          describeStatus("enrollment", row.enrollment.state)
                            .label
                        }
                        {row.enrollment.stopReason
                          ? ` · stopped: ${describeStopReason(row.enrollment.stopReason)}`
                          : ""}
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
                      <dd>
                        {
                          describeStatus("research", row.account.researchStatus)
                            .label
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>Email resolution</dt>
                      <dd>
                        {
                          describeStatus(
                            "emailResolution",
                            row.contact.emailResolutionStatus,
                          ).label
                        }{" "}
                        ·{" "}
                        {row.acceptedEmail
                          ? `${Math.round(Number(row.acceptedEmail.confidence) * 100)}% (${row.acceptedEmail.source}, ${describeStatus("emailCandidate", row.acceptedEmail.status).label.toLowerCase()})`
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
                        {written.length === 0
                          ? "Deterministic template fields only; no AI reasoning field was requested for this step."
                          : `${written.length} sentence${written.length > 1 ? "s" : ""} written by the agent, shown below.`}
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
              {row.message.status === "approved" && row.message.scheduledAt ? (
                // An intent is standing. The card says when it opens and
                // offers the way out, rather than a Send button that would
                // race the lane.
                //
                // Not gated on `bindingFresh`, unlike the Send button beside
                // it. Stale binding is a reason to refuse a send, never a
                // reason to trap one that is already scheduled: cancelling
                // only ever removes a pending action.
                <div className="scheduled-send">
                  <p>
                    {/* The instant is only named when it is a delivery time.
                        A refusal on a delay stores the lane's next look, and
                        printing that reads as an imminent send nobody asked
                        for — see `scheduledInstantLabel`. */}
                    Scheduled for{" "}
                    {scheduledInstantLabel(
                      row.message.scheduledAt,
                      now,
                      sendingSettings?.timezone,
                    )}{" "}
                    — expires {operatorInstant(row.message.sendIntentExpiresAt)}
                  </p>
                  <form
                    action="/api/operator/commands/cancel-scheduled-send"
                    method="post"
                  >
                    <input
                      type="hidden"
                      name="csrf"
                      value={session.csrfToken}
                    />
                    <input
                      type="hidden"
                      name="messageId"
                      value={row.message.id}
                    />
                    <button>Cancel scheduled send</button>
                  </form>
                </div>
              ) : row.message.status === "approved" && bindingFresh ? (
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
              {scheduleOffers.has(row.message.id) ? (
                <form
                  action="/api/operator/commands/schedule-send"
                  method="post"
                >
                  <input type="hidden" name="csrf" value={session.csrfToken} />
                  <input
                    type="hidden"
                    name="messageId"
                    value={row.message.id}
                  />
                  <button>{scheduleOffers.get(row.message.id)}</button>
                </form>
              ) : null}
              {written.length > 0 ? (
                <section className="evidence-list compact">
                  <h3>Written by the agent</h3>
                  {written.map((field) => (
                    <article key={field.id}>
                      <p>
                        <strong>{field.name}</strong> · confidence{" "}
                        {Number(field.confidence).toFixed(2)}
                      </p>
                      <p>{field.value}</p>
                      {field.sourceUrls.map((url) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {url}
                        </a>
                      ))}
                    </article>
                  ))}
                </section>
              ) : null}
              {row.message.lastError ? (
                <p className="alert alert-error">
                  Last attempt: {row.message.lastError}
                </p>
              ) : null}
            </article>
          );
        })}
        {rows.length === 0 ? (
          <section className="panel empty">
            {pendingGenerations === 0 ? (
              "Review queue is clear."
            ) : (
              <>
                Nothing to review yet — {pendingGenerations} message
                {pendingGenerations > 1 ? "s are" : " is"} still being written.{" "}
                <Link href="/outbound">See what goes out</Link>
              </>
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}
