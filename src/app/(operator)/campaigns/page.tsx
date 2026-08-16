import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";

import { getDatabase } from "@/lib/db/client";
import { campaigns, enrollments } from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";

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
            Published versions stay pinned to active enrollments.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}
      <section className="panel">
        <h2>Create campaign</h2>
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
          {[0, 1, 2].map((index) => (
            <fieldset key={index}>
              <legend>Sequence step {index + 1}</legend>
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
                {/* First step only: see the note on the same block in the
                    campaign editor. Follow-up generation never calls the
                    agent, so declaring a field there produces a version that
                    cannot generate. */}
                {index === 0 ? (
                  <>
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
                  </>
                ) : (
                  <p className="muted span-all">
                    Follow-up steps are written from the template alone. Only
                    the first step can ask the agent for a sentence.
                  </p>
                )}
              </div>
            </fieldset>
          ))}
          <button type="submit">Create draft</button>
        </form>
      </section>
      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Campaign registry</h2>
          <span>{rows.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Type</th>
                <th>Status</th>
                <th>Enrollments</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/campaigns/${row.id}`}>{row.name}</Link>
                  </td>
                  <td>{row.type}</td>
                  <td>
                    <span className="badge">{row.status}</span>
                  </td>
                  <td>{row.enrollments}</td>
                  <td>{row.targetDescription}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No campaigns yet.
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
