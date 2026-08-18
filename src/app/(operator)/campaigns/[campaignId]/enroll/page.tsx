import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getDatabase } from "@/lib/db/client";
import {
  campaigns,
  campaignVersions,
  mailboxConnections,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import {
  ENROLLMENT_CANDIDATE_DISPLAY_LIMIT,
  MAXIMUM_ENROLLMENTS_PER_REQUEST,
  parseEnrollmentFilters,
  partitionCandidates,
  readEnrollmentCandidates,
  type EnrollmentIneligibility,
} from "@/modules/campaigns/enrollment-selection";

/**
 * Why a prospect the operator expected is not in the list.
 *
 * Printed as counts rather than as rows: the answer to "where is Tony" is a
 * rule, not a person, and listing the excluded beside the selectable would
 * invite ticking a box that does nothing.
 */
const EXCLUSION_LABELS: Record<EnrollmentIneligibility, string> = {
  already_enrolled: "already enrolled in this campaign",
  suppressed: "address suppressed",
};

export default async function CampaignEnrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{
    notice?: string;
    company?: string;
    role?: string;
    minConfidence?: string;
  }>;
}) {
  const session = await requireOperatorSession();
  const { campaignId } = await params;
  const query = await searchParams;
  const db = getDatabase();
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) notFound();
  const versions = await db
    .select()
    .from(campaignVersions)
    .where(eq(campaignVersions.campaignId, campaign.id))
    .orderBy(desc(campaignVersions.version));
  // The newest *published* version, which is the one an enrollment binds to. A
  // draft revision sitting above it changes nothing for prospects enrolled
  // here, which is what makes a published version immutable in practice.
  const publishedVersion = versions.find((version) => version.publishedAt);
  const filters = parseEnrollmentFilters(query);
  const { eligible, excluded } = partitionCandidates(
    await readEnrollmentCandidates(db, { campaignId: campaign.id, filters }),
  );
  const mailboxes = await db
    .select({
      id: mailboxConnections.id,
      email: mailboxConnections.email,
      provider: mailboxConnections.provider,
    })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.status, "available"));
  const shown = eligible.slice(0, ENROLLMENT_CANDIDATE_DISPLAY_LIMIT);
  const withheld = eligible.length - shown.length;
  // What one press of the second button will actually write. Saying "all 650"
  // on a button that enrolls five hundred of them is a promise the request
  // cannot keep, and the operator would only find out from the notice
  // afterwards.
  const enrollableNow = Math.min(
    eligible.length,
    MAXIMUM_ENROLLMENTS_PER_REQUEST,
  );
  const exclusions = (
    Object.entries(EXCLUSION_LABELS) as Array<[EnrollmentIneligibility, string]>
  )
    .filter(([reason]) => excluded[reason] > 0)
    .map(([reason, label]) => `${excluded[reason]} ${label}`);

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">{campaign.name}</p>
          <h1>Enroll prospects</h1>
          <p className="muted">
            Enrolling queues each prospect&apos;s first message. It appears in
            the review queue once written; nothing is sent without your
            approval.
          </p>
        </div>
        <Link className="button-link" href={`/campaigns/${campaign.id}`}>
          Back to campaign
        </Link>
      </header>
      {query.notice ? (
        <p className="alert" role="status">
          {query.notice}
        </p>
      ) : null}

      <section className="panel">
        <h2>Filter</h2>
        <form method="get" className="inline-form">
          <label>
            Company
            <input name="company" defaultValue={filters.company ?? ""} />
          </label>
          <label>
            Role
            <input name="role" defaultValue={filters.role ?? ""} />
          </label>
          <label>
            Minimum confidence
            {/* `step="any"`, not a fixed increment: the confidences this
                filters against are stored to three decimals and the table
                beside it shows them rounded to a per-cent, so a whole number
                of per-cent is exactly what an operator will type. A 0.05 step
                made the browser refuse 0.92 — a value the same screen
                displays. */}
            <input
              name="minConfidence"
              type="number"
              min={0}
              max={1}
              step="any"
              defaultValue={filters.minConfidence ?? ""}
            />
          </label>
          <button type="submit" className="button-secondary">
            Filter
          </button>
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>{eligible.length} eligible</h2>
          {exclusions.length > 0 ? (
            <span className="muted">Not shown: {exclusions.join(" · ")}</span>
          ) : null}
        </div>

        {!publishedVersion ? (
          <p className="hint">
            Publish the sequence before enrolling.{" "}
            <Link href={`/campaigns/${campaign.id}`}>Go to the campaign</Link>.
          </p>
        ) : mailboxes.length === 0 ? (
          <p className="hint">
            No mailbox is available to send from. Connect one in{" "}
            <Link href="/settings">Settings</Link> first.
          </p>
        ) : (
          <form
            action="/api/operator/commands/enroll-contacts"
            method="post"
            className="stack"
          >
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input
              type="hidden"
              name="campaignVersionId"
              value={publishedVersion.id}
            />
            {/* The filter travels with the action so the "all eligible" button
                can re-derive the very same set server-side, and so the redirect
                comes back to the screen the operator was looking at. */}
            {filters.company ? (
              <input type="hidden" name="company" value={filters.company} />
            ) : null}
            {filters.role ? (
              <input type="hidden" name="role" value={filters.role} />
            ) : null}
            {filters.minConfidence !== undefined ? (
              <input
                type="hidden"
                name="minConfidence"
                value={filters.minConfidence}
              />
            ) : null}

            <label className="mailbox-picker">
              Mailbox
              <select name="mailboxId" required defaultValue="">
                <option value="">Select mailbox</option>
                {mailboxes.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>
                    {mailbox.email} · {mailbox.provider}
                  </option>
                ))}
              </select>
            </label>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="tick-column">
                      <span className="visually-hidden">Select</span>
                    </th>
                    <th>Person</th>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Email</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.contactId}>
                      <td className="tick-column">
                        <input
                          type="checkbox"
                          name="contactId"
                          value={row.contactId}
                          // Names repeat across companies, and the columns that
                          // tell two of them apart are siblings of this box
                          // rather than part of its accessible name.
                          aria-label={`Select ${row.fullName} at ${row.company}`}
                        />
                      </td>
                      <td>
                        <Link href={`/prospects/${row.contactId}`}>
                          {row.fullName}
                        </Link>
                      </td>
                      <td>{row.company}</td>
                      <td>{row.jobTitle ?? "—"}</td>
                      <td>{row.email}</td>
                      <td>{Math.round(row.confidence * 100)}%</td>
                    </tr>
                  ))}
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty">
                        No prospect matches this filter. Widen it, or resolve
                        more addresses on the{" "}
                        <Link href="/prospects">Prospects page</Link>.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {withheld > 0 ? (
              <p className="hint">
                Showing the first {shown.length} of {eligible.length}. Narrow
                the filter to tick people individually.
              </p>
            ) : null}

            <div className="header-actions">
              <button type="submit" name="scope" value="selected">
                Enroll selected
              </button>
              <button
                type="submit"
                name="scope"
                value="filtered"
                className="button-secondary"
                disabled={eligible.length === 0}
              >
                Enroll all {enrollableNow} eligible
              </button>
            </div>
            {/* Said next to the buttons and in every state, not only when the
                list is long enough to be truncated. The second button reads
                the whole eligible set server-side, so an operator who
                unticked three people and pressed it would enroll them
                anyway — and the ticks are right there, inviting that
                reading. */}
            <p className="muted">
              &ldquo;Enroll selected&rdquo; takes the ticked rows. &ldquo;Enroll
              all&rdquo; ignores the ticks and takes every eligible prospect
              this filter matches
              {withheld > 0 ? ", including the ones not shown above" : ""}.
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
