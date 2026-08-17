import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  campaigns,
  contacts,
  emailCandidates,
  enrollments,
  operatorCommands,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { StatusBadge } from "@/modules/presentation/status-badge";
import { describeStatus } from "@/modules/presentation/status";

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const db = getDatabase();
  const [rows, accountRows, pendingCommands] = await Promise.all([
    db
      .select({
        contactId: contacts.id,
        enrollmentId: enrollments.id,
        company: accounts.name,
        person: contacts.fullName,
        role: contacts.jobTitle,
        email: emailCandidates.normalizedEmail,
        confidence: emailCandidates.confidence,
        campaign: campaigns.name,
        state: enrollments.state,
        contactStatus: contacts.status,
        researchStatus: accounts.researchStatus,
        resolutionStatus: contacts.emailResolutionStatus,
      })
      .from(contacts)
      .innerJoin(accounts, eq(accounts.id, contacts.accountId))
      .leftJoin(
        emailCandidates,
        and(
          eq(emailCandidates.contactId, contacts.id),
          eq(emailCandidates.status, "accepted"),
        ),
      )
      .leftJoin(enrollments, eq(enrollments.contactId, contacts.id))
      .leftJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
      .orderBy(desc(contacts.createdAt)),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        domain: accounts.domain,
        industry: accounts.industry,
        country: accounts.country,
        researchStatus: accounts.researchStatus,
        researchedAt: accounts.researchedAt,
        contactCount: sql<number>`count(${contacts.id})::int`,
      })
      .from(accounts)
      .leftJoin(contacts, eq(contacts.accountId, accounts.id))
      .groupBy(accounts.id)
      .orderBy(desc(accounts.updatedAt)),
    db
      .select({
        command: operatorCommands.command,
        payload: operatorCommands.payload,
      })
      .from(operatorCommands)
      .where(
        and(
          inArray(operatorCommands.status, ["queued", "waiting", "running"]),
          // Only work whose result lands on this page. A queued message
          // generation or mailbox sync must not be announced here.
          inArray(operatorCommands.command, [
            "discover-accounts",
            "research-account",
            "discover-contacts",
            "resolve-email",
          ]),
        ),
      ),
  ]);
  // Discovery and research run on the maintenance pass, minutes later — not in
  // this request. Without these markers a clicked button looks like a no-op.
  const busyAccountIds = new Set(
    pendingCommands
      .map((row) => (row.payload as { accountId?: unknown })?.accountId)
      .filter((id): id is string => typeof id === "string"),
  );
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Evidence-backed pipeline</p>
          <h1>Prospects</h1>
          <p className="muted">
            Companies and people, deduplicated globally before any campaign.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      {pendingCommands.length > 0 ? (
        <p className="hint">
          {pendingCommands.length} background task
          {pendingCommands.length > 1 ? "s" : ""} in progress — results appear
          here when the next maintenance pass finishes.{" "}
          <Link href="/outbound">Follow along</Link>
        </p>
      ) : null}

      <details className="panel" open={accountRows.length === 0}>
        <summary>
          Discover accounts with AI
          <small className="muted">describe your ICP, get companies</small>
        </summary>
        <form
          action="/api/operator/commands/discover-accounts"
          method="post"
          className="form-grid"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <input
            type="hidden"
            name="requestToken"
            value={crypto.randomUUID()}
          />
          <label className="span-all">
            Precise ICP
            <textarea
              name="icp"
              required
              rows={4}
              placeholder="European B2B SaaS companies with 50–500 employees hiring product leaders"
            />
          </label>
          <label>
            Countries
            <input name="countries" placeholder="France, Germany, UK" />
          </label>
          <label>
            Industries
            <input name="industries" placeholder="B2B SaaS, fintech" />
          </label>
          <label>
            Required signals
            <input
              name="requiredSignals"
              placeholder="Hiring, recent funding"
            />
          </label>
          <label>
            Result limit
            <input
              name="limit"
              type="number"
              min={1}
              max={100}
              defaultValue={10}
            />
          </label>
          <button type="submit">Run account discovery</button>
        </form>
      </details>

      <details className="panel" open={accountRows.length === 0}>
        <summary>
          Add a prospect manually
          <small className="muted">one known person, one company</small>
        </summary>
        <form
          action="/api/operator/commands/create-prospect"
          method="post"
          className="form-grid"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <label>
            Company
            <input name="companyName" required />
          </label>
          <label>
            Domain
            <input name="domain" placeholder="example.com" />
          </label>
          <label>
            First name
            <input name="firstName" required />
          </label>
          <label>
            Last name
            <input name="lastName" required />
          </label>
          <label>
            Job title
            <input name="jobTitle" />
          </label>
          <label>
            Email
            <input name="email" type="email" />
          </label>
          <button type="submit">Save prospect</button>
        </form>
      </details>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Companies</h2>
          <span className="muted">{accountRows.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Profile</th>
                <th>Research</th>
                <th>Contacts</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accountRows.map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.name}
                    <small>{account.domain ?? "Domain unresolved"}</small>
                  </td>
                  <td>
                    {account.industry ?? "—"}
                    <small>{account.country ?? ""}</small>
                  </td>
                  <td>
                    <StatusBadge
                      kind="research"
                      value={account.researchStatus}
                    />
                    <small>
                      {busyAccountIds.has(account.id)
                        ? "Task in progress…"
                        : account.researchedAt
                          ? `Fetched ${account.researchedAt.toLocaleString()}`
                          : ""}
                    </small>
                  </td>
                  <td>{account.contactCount}</td>
                  <td>
                    <div className="button-stack compact-form">
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
                          value={account.id}
                        />
                        <input
                          type="hidden"
                          name="requestToken"
                          value={crypto.randomUUID()}
                        />
                        <input
                          type="hidden"
                          name="returnTo"
                          value="/prospects"
                        />
                        <button className="button-secondary">
                          Research account
                        </button>
                      </form>
                      <form
                        action="/api/operator/commands/discover-contacts"
                        method="post"
                        className="stack"
                      >
                        <input
                          type="hidden"
                          name="csrf"
                          value={session.csrfToken}
                        />
                        <input
                          type="hidden"
                          name="accountId"
                          value={account.id}
                        />
                        <input
                          type="hidden"
                          name="requestToken"
                          value={crypto.randomUUID()}
                        />
                        <input
                          type="hidden"
                          name="returnTo"
                          value="/prospects"
                        />
                        <input
                          name="roles"
                          required
                          aria-label={`Target roles for ${account.name}`}
                          placeholder="Founder, Head of Product"
                        />
                        <input
                          name="limit"
                          type="number"
                          min={1}
                          max={100}
                          defaultValue={10}
                          aria-label={`Contact limit for ${account.name}`}
                        />
                        <button>Discover contacts</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
              {accountRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No companies yet. Run account discovery or add a prospect
                    above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>People</h2>
          <span className="muted">{rows.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Company</th>
                <th>Role</th>
                <th>Email</th>
                <th>Campaign</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.contactId}-${row.enrollmentId ?? "available"}`}>
                  <td>
                    <Link href={`/prospects/${row.contactId}`}>
                      {row.person}
                    </Link>
                  </td>
                  <td>{row.company}</td>
                  <td>{row.role ?? "—"}</td>
                  <td>
                    {row.email ?? "Unresolved"}
                    <small>
                      {row.confidence
                        ? `${Math.round(Number(row.confidence) * 100)}% confidence`
                        : describeStatus(
                            "emailResolution",
                            row.resolutionStatus,
                          ).label}
                    </small>
                  </td>
                  <td>{row.campaign ?? "—"}</td>
                  <td>
                    {/* Without an enrollment, the contact's own lifecycle is
                        the status — a rejected or opted-out contact must not
                        hide behind a bare "not enrolled". */}
                    {row.state ? (
                      <StatusBadge kind="enrollment" value={row.state} />
                    ) : (
                      <StatusBadge kind="contact" value={row.contactStatus} />
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No people yet. Discover contacts on a company, or add a
                    prospect above.
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
