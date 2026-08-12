import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import {
  accounts,
  campaigns,
  contacts,
  emailCandidates,
  enrollments,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const db = getDatabase();
  const [rows, accountRows] = await Promise.all([
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
  ]);

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Evidence-backed pipeline</p>
          <h1>Prospects</h1>
          <p className="muted">
            Global contacts are deduplicated before campaign enrollment.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      <section className="panel">
        <h2>Discover matching accounts</h2>
        <p className="muted">
          Runs the configured research provider, normalizes companies, and
          reuses existing accounts by identity.
        </p>
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
      </section>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>Account registry</h2>
            <p className="muted">
              Discovered companies remain operable before any contact exists.
            </p>
          </div>
          <span>{accountRows.length} accounts</span>
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
                    {account.industry ?? "Industry unknown"}
                    <small>{account.country ?? "Country unknown"}</small>
                  </td>
                  <td>
                    <span className="badge">{account.researchStatus}</span>
                    <small>
                      {account.researchedAt
                        ? `Fetched ${account.researchedAt.toLocaleString()}`
                        : "No research snapshot yet"}
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
                    No accounts yet. Run ICP discovery above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Add a prospect</h2>
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
      </section>
      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>All prospects</h2>
          <span>{rows.length} rows</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Person</th>
                <th>Role</th>
                <th>Email confidence</th>
                <th>Campaign</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.contactId}-${row.enrollmentId ?? "available"}`}>
                  <td>
                    {row.company}
                    <small>{row.researchStatus}</small>
                  </td>
                  <td>
                    <Link href={`/prospects/${row.contactId}`}>
                      {row.person}
                    </Link>
                  </td>
                  <td>{row.role ?? "—"}</td>
                  <td>
                    {row.email ?? "Unresolved"}
                    <small>
                      {row.confidence
                        ? `${Math.round(Number(row.confidence) * 100)}%`
                        : row.resolutionStatus}
                    </small>
                  </td>
                  <td>{row.campaign ?? "—"}</td>
                  <td>
                    <span className="badge">{row.state ?? "not enrolled"}</span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No prospects yet. Add one above or run discovery.
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
