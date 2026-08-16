import { eq } from "drizzle-orm";

import maintenanceConfig from "../../../../config/maintenance.json";
import { getDatabase } from "@/lib/db/client";
import { maintenanceState, operatorSendingSettings } from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { scheduledInstantLabel } from "@/modules/messages/scheduled-send";
import { operatorClock } from "@/modules/settings/working-hours";
import {
  getMaintenanceCodeTimeoutMs,
  getMaintenanceStatusPresentation,
} from "@/modules/workflows/maintenance-status-presentation";
import { resolveMaintenanceStatus } from "@/modules/workflows/maintenance-status";
import {
  readDueFollowUps,
  readQueuedWork,
  readRecentSends,
  readScheduledSends,
  readSendBudgets,
} from "@/modules/workflows/outbound-today";

export default async function OutboundPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireOperatorSession();
  const { notice } = await searchParams;
  const db = getDatabase();
  const now = new Date();
  const [
    budgets,
    queuedWork,
    dueFollowUps,
    scheduledSends,
    recentSends,
    maintenanceRows,
    sendingSettingsRows,
  ] = await Promise.all([
    readSendBudgets(db, now),
    readQueuedWork(db),
    readDueFollowUps(db, { now }),
    readScheduledSends(db),
    readRecentSends(db, { now }),
    db.select().from(maintenanceState).limit(1),
    // The instants in the scheduled-sends table are promises this system made,
    // and the review card prints the same ones on the operator's clock. A slot
    // computed against a 09:00 calendar must not read as 07:00 UTC on one page
    // and 09:00 on the other. The rest of this page is telemetry and keeps the
    // host's locale.
    db
      .select({ timezone: operatorSendingSettings.timezone })
      .from(operatorSendingSettings)
      .where(eq(operatorSendingSettings.id, 1))
      .limit(1),
  ]);
  const operatorTimezone = sendingSettingsRows[0]?.timezone;
  // Everything on this page is executed by the maintenance pass. If that
  // stopped, a queue that is merely slow and a queue that is dead look
  // identical — and this is the page the operator is on while waiting, so it
  // is the page that has to tell them apart.
  const maintenance = maintenanceRows[0] ?? {
    ownerToken: null,
    cycleStartedAt: null,
    heartbeatAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastError: null,
  };
  const maintenanceStatus = resolveMaintenanceStatus(maintenance, {
    now,
    intervalMs: maintenanceConfig.intervalMs,
    codeTimeoutMs: getMaintenanceCodeTimeoutMs(process.env),
    staleLeaseMs: maintenanceConfig.staleLeaseMs,
  });
  const maintenancePresentation = getMaintenanceStatusPresentation(
    maintenanceStatus.state,
  );

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Next 24 hours</p>
          <h1>What goes out</h1>
          <p className="muted">
            Everything the system will do on its own, before it does it — and
            everything it is waiting on.
          </p>
        </div>
      </header>
      {notice ? (
        <p className="alert" role="status">
          {notice}
        </p>
      ) : null}

      <section className="panel">
        <h2>Maintenance pass</h2>
        <dl className="facts">
          <div>
            <dt>State</dt>
            <dd>
              <span className="badge">{maintenancePresentation.label}</span>{" "}
              {maintenancePresentation.detail}
            </dd>
          </div>
          <div>
            <dt>Last completed</dt>
            <dd>
              {maintenance.lastSucceededAt
                ? maintenance.lastSucceededAt.toLocaleString()
                : "Never"}
            </dd>
          </div>
          <div>
            <dt>Runs every</dt>
            <dd>{maintenanceConfig.intervalMs / 1000} seconds</dd>
          </div>
          {/* Only while it is still the latest word. The cycle records
              `lastError` on failure and never clears it on success, so
              rendering on truthiness alone left a months-old failure sitting
              under a healthy badge, reading as a live problem. */}
          {maintenance.lastError &&
          maintenance.lastFailedAt &&
          (!maintenance.lastSucceededAt ||
            maintenance.lastFailedAt.getTime() >
              maintenance.lastSucceededAt.getTime()) ? (
            <div>
              <dt>Last failure</dt>
              <dd>{maintenance.lastError}</dd>
            </div>
          ) : null}
        </dl>
        {maintenanceStatus.state === "stalled" ||
        maintenanceStatus.state === "not_started" ? (
          <p className="alert alert-error">
            Nothing below will run until the maintenance worker is going. Start
            the application with <code>npm run dev</code> or{" "}
            <code>npm start</code>, which launches it alongside the web server.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Sending budget</h2>
        <p className="muted">
          Counted the way the send policy counts it: an attempt spends the
          budget whether or not it was delivered.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Name</th>
                <th>Used in the last 24 hours</th>
                <th>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((budget) => (
                <tr key={`${budget.scope}-${budget.name}`}>
                  <td>{budget.scope}</td>
                  <td>{budget.name}</td>
                  <td>
                    {budget.used} / {budget.cap}
                  </td>
                  <td>{Math.max(0, budget.cap - budget.used)}</td>
                </tr>
              ))}
              {budgets.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">
                    No mailbox or active campaign yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Queued work</h2>
        <p className="muted">
          Research and discovery run on the maintenance pass, not in your
          browser. This is where they are.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Detail</th>
                <th>Requested</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {queuedWork.map((work) => (
                <tr key={work.id}>
                  <td>{work.command}</td>
                  <td>
                    <span className="badge">{work.status}</span>
                  </td>
                  <td>
                    {work.attempt} / {work.maxAttempts}
                  </td>
                  <td>{work.detail || "—"}</td>
                  <td>{work.createdAt.toLocaleString()}</td>
                  <td>
                    {work.retryable ? (
                      <form
                        action="/api/operator/commands/retry-command"
                        method="post"
                      >
                        <input
                          type="hidden"
                          name="csrf"
                          value={session.csrfToken}
                        />
                        <input type="hidden" name="commandId" value={work.id} />
                        <button className="button-secondary">Try again</button>
                      </form>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {queuedWork.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Nothing queued.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Scheduled sends</h2>
        <p className="muted">
          You asked for these and the policy refused for a reason time lifts.
          They go out on their own at the first instant it allows, and never
          before — an expired one comes back to the review queue instead. Where
          that instant can be named it is; a refusal on a delay only says
          &ldquo;not yet&rdquo;, and the wait ends whenever it truly ends.
        </p>
        <table>
          <thead>
            <tr>
              <th>Goes out</th>
              <th>Expires</th>
              <th>Campaign</th>
              <th>Recipient</th>
              <th>Subject</th>
            </tr>
          </thead>
          <tbody>
            {scheduledSends.map((scheduled) => (
              <tr key={scheduled.messageId}>
                {/* Named only when it is a delivery time. The lane stores its
                    own next look for a refusal on a delay, and printing that
                    as "goes out" reads as an imminent send nobody asked for on
                    the one page whose subject is what is leaving. */}
                <td>
                  {scheduledInstantLabel(
                    scheduled.scheduledAt,
                    now,
                    operatorTimezone,
                  )}
                </td>
                <td>
                  {scheduled.expiresAt
                    ? operatorClock(scheduled.expiresAt, operatorTimezone)
                    : "—"}
                </td>
                <td>{scheduled.campaignName}</td>
                <td>{scheduled.recipient}</td>
                <td>{scheduled.subject}</td>
              </tr>
            ))}
            {scheduledSends.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  Nothing is waiting for a slot.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Follow-ups due</h2>
        <p className="muted">
          These leave without another click. The text below is what the template
          resolves to right now.
        </p>
        <div className="review-list">
          {dueFollowUps.map((followUp) => (
            <article className="review-card" key={followUp.enrollmentId}>
              <header>
                <div>
                  <p className="eyebrow">
                    {followUp.campaignName} · step {followUp.step}
                  </p>
                  <h3>
                    {followUp.contactName} · {followUp.accountName}
                  </h3>
                  <p className="muted">Due {followUp.dueAt.toLocaleString()}</p>
                </div>
                <span className="badge">due</span>
              </header>
              {followUp.subject ? (
                <>
                  <p>
                    <strong>{followUp.subject}</strong>
                  </p>
                  <pre>{followUp.body}</pre>
                </>
              ) : null}
              <p className="muted">{followUp.note}</p>
            </article>
          ))}
          {dueFollowUps.length === 0 ? (
            <section className="panel empty">
              No follow-up is due in the next 24 hours.
            </section>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <h2>Just sent</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Campaign</th>
                <th>State</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recentSends.map((send) => (
                <tr key={send.messageId}>
                  <td>{send.recipient}</td>
                  <td>{send.subject}</td>
                  <td>{send.campaignName}</td>
                  <td>
                    <span className="badge">{send.status}</span>
                  </td>
                  <td>
                    {(send.sentAt ?? send.attemptedAt)?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
              {recentSends.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    Nothing has gone out in the last 24 hours.
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
