import { eq } from "drizzle-orm";

import maintenanceConfig from "../../../../config/maintenance.json";
import { getDatabase } from "@/lib/db/client";
import { maintenanceState, operatorSendingSettings } from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { StatusBadge } from "@/modules/presentation/status-badge";
import { scheduledInstantLabel } from "@/modules/messages/scheduled-send";
import { operatorClock } from "@/modules/settings/working-hours";
import {
  readAddressLadderMetrics,
  readConventionOutcomes,
  readLadderSettings,
} from "@/modules/email-resolution/ladder-service";
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
  const ladderSettings = await readLadderSettings(db);
  const [ladderMetrics, conventionOutcomes] = await Promise.all([
    readAddressLadderMetrics(db, { now }),
    readConventionOutcomes(db, {
      minimumPeople: ladderSettings.demotionMinimumPeople,
      failureSharePercent: ladderSettings.demotionFailureSharePercent,
    }),
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
        <div className="panel-heading">
          <h2>Maintenance pass</h2>
          <span className="badge">{maintenancePresentation.label}</span>
        </div>
        <p className="muted">
          {maintenancePresentation.detail} Runs every{" "}
          {maintenanceConfig.intervalMs / 1000} seconds · last completed{" "}
          {maintenance.lastSucceededAt
            ? maintenance.lastSucceededAt.toLocaleString()
            : "never"}
          .
        </p>
        {/* Only while it is still the latest word. The cycle records
            `lastError` on failure and never clears it on success, so
            rendering on truthiness alone left a months-old failure sitting
            under a healthy badge, reading as a live problem. */}
        {maintenance.lastError &&
        maintenance.lastFailedAt &&
        (!maintenance.lastSucceededAt ||
          maintenance.lastFailedAt.getTime() >
            maintenance.lastSucceededAt.getTime()) ? (
          <p className="alert alert-error">
            Last failure: {maintenance.lastError}
          </p>
        ) : null}
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
        <h2>Address ladder</h2>
        <p className="muted">
          The feature deliberately spends deliverability, so its yield and its
          cost are read together. A send is only ever counted as delivered when
          something came back: a reply, an out-of-office, an autoresponder.
          Everything else with no explicit failure is no signal, never delivered
          — silence does not prove anything in either direction, and whether the
          domains being targeted report failures at all is what the “no signal”
          column measures.
        </p>
        <dl className="facts">
          <div>
            <dt>Alive on rung one</dt>
            <dd>{ladderMetrics.onFirstRung}</dd>
          </div>
          <div>
            <dt>Reached on a later rung</dt>
            <dd>{ladderMetrics.advanced}</dd>
          </div>
          <div>
            <dt>No further address to try</dt>
            <dd>{ladderMetrics.exhausted}</dd>
          </div>
          <div>
            <dt>Stopped before another address</dt>
            <dd>{ladderMetrics.limited}</dd>
          </div>
          <div>
            <dt>Sends attempted (30 days)</dt>
            <dd>{ladderMetrics.sendsAttempted}</dd>
          </div>
          <div>
            <dt>Explicit delivery failures</dt>
            <dd>
              {ladderMetrics.sendsProvenDead}
              <small>{ladderMetrics.failureSharePercent}% of attempts</small>
            </dd>
          </div>
          <div>
            <dt>Reached a real mailbox</dt>
            <dd>
              {ladderMetrics.sendsAcknowledged}
              <small>something came back that was not a failure</small>
            </dd>
          </div>
          <div>
            <dt>No signal at all</dt>
            <dd>{ladderMetrics.sendsNoSignal}</dd>
          </div>
          <div>
            <dt>Circuit breaker</dt>
            <dd>
              {ladderMetrics.circuitOpen ? "Open — not advancing" : "Closed"}
              <small>
                trips at {ladderSettings.failureRatePercent}% from{" "}
                {ladderSettings.failureRateMinimumSends} attempts
              </small>
            </dd>
          </div>
        </dl>
        {!ladderSettings.enabled ? (
          <p className="hint">
            The ladder is switched off in Settings: a proven-dead address ends
            the prospect instead of advancing.
          </p>
        ) : null}
        <h3>By convention</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Convention</th>
                <th>People attempted</th>
                <th>Proven dead</th>
                <th>No signal</th>
                <th>Companies</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {conventionOutcomes.map((outcome) => (
                <tr key={outcome.pattern}>
                  <td>{outcome.pattern}</td>
                  <td>{outcome.peopleAttempted}</td>
                  <td>{outcome.peopleProvenDead}</td>
                  <td>{outcome.peopleNoSignal}</td>
                  <td>{outcome.attemptedDomains}</td>
                  <td>
                    {outcome.demotedDomains.length === 0
                      ? "Normal everywhere"
                      : `Demoted at ${outcome.demotedDomains.join(", ")}`}
                  </td>
                </tr>
              ))}
              {conventionOutcomes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No address has been attempted yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
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
                    <StatusBadge kind="command" value={work.status} />
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
          Approved sends waiting for the first instant policy allows. An expired
          one returns to the review queue instead of going out.
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
                    <StatusBadge kind="message" value={send.status} />
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
