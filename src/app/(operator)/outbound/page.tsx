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
  readConventionDemotionRecords,
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
  const [ladderMetrics, conventionOutcomes, demotionRecords] =
    await Promise.all([
      readAddressLadderMetrics(db, { now }),
      readConventionOutcomes(db, {
        minimumPeople: ladderSettings.demotionMinimumPeople,
        failureSharePercent: ladderSettings.demotionFailureSharePercent,
      }),
      readConventionDemotionRecords(db),
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
          cost are read together. Each send falls in exactly one of three
          buckets. It was proven not to exist — a hard bounce or a definite
          refusal. Something came back that was not a failure — a reply, an
          out-of-office, an autoresponder — which proves the mailbox is real. Or
          nothing came back, which proves nothing in either direction and is
          never read as delivered. A temporary failure sits in that last bucket
          too: it says the address may be wrong, never that it is. Whether the
          domains being written to report bad addresses back at all is what that
          bucket measures, and it is the assumption the whole feature rests on.
        </p>
        <dl className="facts">
          <div>
            <dt>Alive on rung one</dt>
            <dd>{ladderMetrics.onFirstRung}</dd>
          </div>
          <div>
            <dt>Alive on a later rung</dt>
            <dd>
              {ladderMetrics.onLaterRung}
              <small>{ladderMetrics.advanced} of them after a death</small>
            </dd>
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
            <dt>Nothing came back</dt>
            <dd>
              {ladderMetrics.sendsNoSignal}
              <small>including temporary failures, which prove nothing</small>
            </dd>
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
        {demotionRecords.length > 0 ? (
          <>
            <h3>Demoted conventions</h3>
            <p className="muted">
              A hard bounce cannot tell a wrong convention from a person who has
              left, so a company that lost several people in a quarter can
              discredit a convention that works — and nothing in the delivery
              record will ever say so, because the record is the thing that is
              wrong. Restoring one sets aside the evidence below and starts that
              company&rsquo;s record again from today: if you are right the
              convention goes back to the front, and if you are wrong the next
              failures demote it again.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Convention</th>
                    <th>Evidence</th>
                    <th>State</th>
                    <th>Restore</th>
                  </tr>
                </thead>
                <tbody>
                  {demotionRecords.map((record) => (
                    <tr key={record.id}>
                      <td>{record.domain}</td>
                      <td>{record.pattern}</td>
                      <td>
                        {record.peopleProvenDead} of {record.peopleAttempted}{" "}
                        people proven dead
                        <small>
                          decided {record.demotedAt.toLocaleDateString()}
                        </small>
                      </td>
                      <td>
                        {record.liftedAt ? (
                          <>
                            Restored {record.liftedAt.toLocaleDateString()}
                            <small>
                              by {record.liftedBy} — {record.liftReason}
                            </small>
                          </>
                        ) : (
                          "Demoted"
                        )}
                      </td>
                      <td>
                        {record.liftedAt ? (
                          <span className="muted">—</span>
                        ) : (
                          <form
                            action="/api/operator/commands/lift-convention-demotion"
                            method="post"
                            className="stack compact-form"
                          >
                            <input
                              type="hidden"
                              name="csrf"
                              value={session.csrfToken}
                            />
                            <input
                              type="hidden"
                              name="domain"
                              value={record.domain}
                            />
                            <input
                              type="hidden"
                              name="pattern"
                              value={record.pattern}
                            />
                            <input
                              name="justification"
                              required
                              placeholder="What the record misread"
                            />
                            <label className="check">
                              <input
                                type="checkbox"
                                name="confirmedConventionInUse"
                                required
                              />
                              This company does use this convention
                            </label>
                            <button type="submit">Restore</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        <h3>By convention</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Convention</th>
                <th>People attempted</th>
                <th>Proven dead</th>
                <th>No failure reported</th>
                <th>Companies</th>
                <th>Ladder order</th>
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
                      : outcome.demotedDomains.length <= 3
                        ? `Demoted at ${outcome.demotedDomains.join(", ")}`
                        : `Demoted at ${outcome.demotedDomains.length} companies`}
                    {outcome.demotedDomains.length > 3 ? (
                      // Named in full below the count rather than in the cell: a
                      // latch never expires, so a common convention accumulates
                      // companies indefinitely and one comma list stops being
                      // readable long before it stops being true.
                      <small>{outcome.demotedDomains.join(", ")}</small>
                    ) : null}
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
