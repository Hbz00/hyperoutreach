import { and, inArray, isNotNull, ne, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  contacts,
  enrollments,
  mailboxConnections,
  messages,
  replies,
  suppressionEntries,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { readEditFreeStreaks } from "@/modules/campaigns/edit-streak";
import { resolveAIProviderConfig } from "@/lib/ai/provider-config";
import { getProviderPresentation } from "@/modules/settings/provider-presentation";
import { resolveWorkflowProvider } from "@/modules/workflows/provider-config";

function countRows(
  table: typeof accounts | typeof replies | typeof suppressionEntries,
) {
  return getDatabase()
    .select({ count: sql<number>`count(*)::int` })
    .from(table);
}

export default async function DashboardPage() {
  await requireOperatorSession();
  const db = getDatabase();
  const [
    mailboxes,
    [{ count: accountCount = 0 } = { count: 0 }],
    [{ count: emailActionCount = 0 } = { count: 0 }],
    [{ count: reviewCount = 0 } = { count: 0 }],
    [{ count: followUpCount = 0 } = { count: 0 }],
    [{ count: replyCount = 0 } = { count: 0 }],
    [{ count: suppressionCount = 0 } = { count: 0 }],
    editFreeStreaks,
  ] = await Promise.all([
    db
      .select({
        provider: mailboxConnections.provider,
        status: mailboxConnections.status,
        lastSyncedAt: mailboxConnections.lastSyncedAt,
      })
      .from(mailboxConnections),
    countRows(accounts),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(ne(contacts.emailResolutionStatus, "resolved")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        inArray(messages.status, [
          "proposed",
          "approved",
          "delivery_uncertain",
          "failed",
        ]),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(enrollments)
      .where(
        and(
          isNotNull(enrollments.nextActionAt),
          inArray(enrollments.state, ["active", "waiting"]),
        ),
      ),
    countRows(replies),
    countRows(suppressionEntries),
    readEditFreeStreaks(db),
  ]);
  const liveMailboxes = mailboxes.filter(
    (mailbox) => mailbox.provider !== "mock" && mailbox.status === "available",
  );
  const mockMailboxes = mailboxes.filter(
    (mailbox) => mailbox.provider === "mock" && mailbox.status === "available",
  );
  const latestLiveSync = liveMailboxes
    .flatMap((mailbox) => (mailbox.lastSyncedAt ? [mailbox.lastSyncedAt] : []))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  let provider = {
    provider: "Misconfigured",
    researchModel: "Unavailable",
  };
  try {
    provider = getProviderPresentation(
      resolveAIProviderConfig(process.env),
      resolveWorkflowProvider(process.env),
    );
  } catch {
    // The dashboard remains operable and Settings exposes the actionable
    // configuration notice without rendering raw environment failures.
  }

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operator dashboard</p>
          <h1>Campaign state at a glance</h1>
          <p className="muted">
            Follow the numbered path below. Every count comes from persisted
            application state, not the workflow provider.
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>Your operating path</h2>
        <ol className="workflow-path" aria-label="Outreach workflow">
          <li>
            <Link href="/settings">1. Settings</Link>
            <span>
              Connect a mailbox, sync it, and set conservative limits.
            </span>
          </li>
          <li>
            <Link href="/campaigns">2. Campaigns</Link>
            <span>Create the ICP and publish an immutable sequence.</span>
          </li>
          <li>
            <Link href="/prospects">3. Prospects</Link>
            <span>
              Discover companies, research evidence, people, and email.
            </span>
          </li>
          <li>
            <Link href="/campaigns">4. Campaign enrollment</Link>
            <span>Choose resolved prospects and the sending mailbox.</span>
          </li>
          <li>
            <Link href="/review">5. Review queue</Link>
            <span>Inspect the exact message, approve it, and send.</span>
          </li>
          <li>
            <Link href="/inbox">6. Inbox</Link>
            <span>
              Review classifications, sequence stops, and suppressions.
            </span>
          </li>
        </ol>
      </section>

      <section className="card-grid" aria-label="Current operating state">
        <Link className="metric-card" href="/settings">
          <strong>Mailbox readiness</strong>
          <span className="metric-value">
            {liveMailboxes.length} live · {mockMailboxes.length} mock
          </span>
          <small>
            {latestLiveSync
              ? `Last live sync ${latestLiveSync.toLocaleString()}`
              : "No live mailbox has synchronized yet"}
          </small>
        </Link>
        <Link className="metric-card" href="/settings">
          <strong>AI provider</strong>
          <span className="metric-value">{provider.provider}</span>
          <small>{provider.researchModel}</small>
        </Link>
        <Link className="metric-card" href="/prospects">
          <strong>Accounts discovered</strong>
          <span className="metric-value">{accountCount}</span>
          <small>Research is shared by every contact at one company</small>
        </Link>
        <Link className="metric-card" href="/prospects">
          <strong>Emails requiring action</strong>
          <span className="metric-value">{emailActionCount}</span>
          <small>Unresolved, low-confidence, or provider-error contacts</small>
        </Link>
        <Link className="metric-card" href="/review">
          <strong>Messages requiring action</strong>
          <span className="metric-value">{reviewCount}</span>
          <small>Review, send, uncertain delivery, or failed state</small>
        </Link>
        <Link className="metric-card" href="/campaigns">
          <strong>Follow-ups scheduled</strong>
          <span className="metric-value">{followUpCount}</span>
          <small>Every due send is policy-checked again at execution</small>
        </Link>
        <Link className="metric-card" href="/inbox">
          <strong>Replies ingested</strong>
          <span className="metric-value">{replyCount}</span>
          <small>Classifications and deterministic sequence outcomes</small>
        </Link>
        <Link className="metric-card" href="/settings">
          <strong>Persistent suppressions</strong>
          <span className="metric-value">{suppressionCount}</span>
          <small>Checked immediately before every send</small>
        </Link>
      </section>
      <section className="panel">
        <h2>Review is still changing the outcome</h2>
        <p className="muted">
          Consecutive approvals where you changed nothing, per published
          campaign version. A long unbroken run is the evidence — and the only
          evidence this product has — that reading each first email has stopped
          altering what goes out. One rewrite restarts the count.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Version</th>
                <th>Approved without a rewrite</th>
                <th>Approvals</th>
              </tr>
            </thead>
            <tbody>
              {editFreeStreaks.map((row) => (
                <tr key={`${row.campaignId}-${row.version}`}>
                  <td>{row.campaignName}</td>
                  <td>v{row.version}</td>
                  <td>{row.streak} in a row</td>
                  <td>{row.total}</td>
                </tr>
              ))}
              {editFreeStreaks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">
                    Nothing approved yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
