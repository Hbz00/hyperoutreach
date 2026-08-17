import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import { campaigns, enrollments } from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { StatusBadge } from "@/modules/presentation/status-badge";

const CAMPAIGN_TYPES: Record<string, string> = {
  customer_discovery: "Customer discovery",
  commercial_outreach: "Commercial outreach",
  other: "Other",
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const rows = await getDatabase()
    .select({
      id: campaigns.id,
      name: campaigns.name,
      type: campaigns.type,
      status: campaigns.status,
      targetDescription: campaigns.targetDescription,
      enrollments: sql<number>`count(${enrollments.id})::int`,
      updatedAt: campaigns.updatedAt,
    })
    .from(campaigns)
    .leftJoin(enrollments, eq(enrollments.campaignId, campaigns.id))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.updatedAt));
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Immutable sequences</p>
          <h1>Campaigns</h1>
          <p className="muted">
            A campaign is drafted, published, then enrolls prospects. Published
            versions never change under an enrollment.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}

      <details className="panel" open={rows.length === 0}>
        <summary>
          Create a campaign
          <small className="muted">draft first — publish when ready</small>
        </summary>
        <form
          action="/api/operator/commands/create-campaign"
          method="post"
          className="stack"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <div className="form-grid">
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Type
              <select name="type" defaultValue="customer_discovery">
                <option value="customer_discovery">Customer discovery</option>
                <option value="commercial_outreach">Commercial outreach</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="span-all">
              Precise ICP
              <textarea
                name="targetDescription"
                rows={3}
                minLength={10}
                required
                placeholder="Who this campaign is for, in one or two sentences"
              />
            </label>
            <label>
              Campaign daily cap
              <input
                type="number"
                name="campaignDailyCap"
                min={1}
                defaultValue={50}
              />
            </label>
            <label className="check">
              <input type="checkbox" name="automaticFollowUps" />
              Automatic follow-ups
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="holdNonTerminalReplies"
                defaultChecked
              />
              Hold on unclear replies
            </label>
            <label className="check">
              <input type="checkbox" name="requireProfessionalRelevance" />
              Require professional relevance
            </label>
          </div>
          <p className="muted">
            Steps 2 and 3 are optional follow-ups — leave subject and body empty
            to skip them.
          </p>
          {[0, 1, 2].map((index) => (
            <fieldset key={index}>
              <legend>
                {index === 0 ? "Step 1 — first email" : `Step ${index + 1}`}
              </legend>
              <div className="form-grid">
                <label>
                  Delay in minutes
                  <input
                    name={`step${index}DelayMinutes`}
                    type="number"
                    min={0}
                    defaultValue={index === 0 ? 0 : 4320}
                  />
                </label>
                <label>
                  Subject
                  <input
                    name={`step${index}Subject`}
                    defaultValue={
                      index === 0
                        ? "A question for {{company}}"
                        : "Following up, {{first_name}}"
                    }
                    required={index === 0}
                  />
                </label>
                <label className="span-all">
                  Body
                  <textarea
                    name={`step${index}Body`}
                    rows={4}
                    defaultValue={
                      index === 0
                        ? "Hello {{first_name}},\n\nI am speaking with {{job_title}} leaders at companies like {{company}}. Would you be open to a short conversation?"
                        : "Hello {{first_name}},\n\nI wanted to follow up on my previous note."
                    }
                    required={index === 0}
                  />
                </label>
                <label className="span-all check">
                  <input type="checkbox" name={`step${index}AiOpening`} />
                  AI-written opening sentence — reference it as{" "}
                  <code>{"{{personalized_opening}}"}</code>
                </label>
                <label className="span-all check">
                  <input type="checkbox" name={`step${index}AiRelevance`} />
                  AI-written company relevance — reference it as{" "}
                  <code>{"{{company_relevance}}"}</code>
                </label>
                <label>
                  Minimum AI confidence
                  <input
                    name={`step${index}MinConfidence`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    defaultValue={0.5}
                  />
                </label>
              </div>
            </fieldset>
          ))}
          <button type="submit">Create draft</button>
        </form>
      </details>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>All campaigns</h2>
          <span className="muted">{rows.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Type</th>
                <th>Status</th>
                <th>Enrollments</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/campaigns/${row.id}`}>{row.name}</Link>
                    <small>{row.targetDescription}</small>
                  </td>
                  <td>{CAMPAIGN_TYPES[row.type] ?? row.type}</td>
                  <td>
                    <StatusBadge kind="campaign" value={row.status} />
                  </td>
                  <td>{row.enrollments}</td>
                  <td>{row.updatedAt.toLocaleDateString()}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No campaigns yet. Create one above.
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
