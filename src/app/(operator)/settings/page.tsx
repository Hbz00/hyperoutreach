import { desc } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  DEFAULT_OPENAI_FAST_MODEL,
  DEFAULT_OPENAI_RESEARCH_MODEL,
} from "@/lib/openai/config";
import {
  agentRuns,
  graphNotificationReceipts,
  mailboxConnections,
  workflowEvents,
} from "@/lib/db/schema";
import { requireOperatorSession } from "@/lib/operator-session-server";
import { getOperatorSendingSettings } from "@/modules/settings/service";
import { listSuppressions } from "@/modules/suppression/service";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; microsoft?: string }>;
}) {
  const session = await requireOperatorSession();
  const query = await searchParams;
  const db = getDatabase();
  const openAIEnabled = process.env.OPENAI_PROVIDER === "openai";
  const [
    settings,
    suppressions,
    mailboxes,
    workflows,
    runs,
    notificationFailures,
  ] = await Promise.all([
    getOperatorSendingSettings(db),
    listSuppressions(db, {}),
    db
      .select({
        id: mailboxConnections.id,
        provider: mailboxConnections.provider,
        email: mailboxConnections.email,
        status: mailboxConnections.status,
        grantedScopes: mailboxConnections.grantedScopes,
        lastSyncedAt: mailboxConnections.lastSyncedAt,
        subscriptionExpiresAt: mailboxConnections.subscriptionExpiresAt,
      })
      .from(mailboxConnections)
      .orderBy(desc(mailboxConnections.updatedAt)),
    db
      .select()
      .from(workflowEvents)
      .orderBy(desc(workflowEvents.createdAt))
      .limit(50),
    db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(30),
    db
      .select()
      .from(graphNotificationReceipts)
      .orderBy(desc(graphNotificationReceipts.receivedAt))
      .limit(30),
  ]);
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operations & integrations</p>
          <h1>Settings</h1>
          <p className="muted">
            Provider state, deterministic sending limits, suppression, and
            failures.
          </p>
        </div>
      </header>
      {query.notice ? (
        <p className="alert" role="status">
          {query.notice}
        </p>
      ) : null}
      {query.microsoft ? (
        <p className="alert" role="status">
          Microsoft: {query.microsoft}
        </p>
      ) : null}
      <section className="panel">
        <h2>Provider configuration</h2>
        <dl className="facts">
          <div>
            <dt>AI provider</dt>
            <dd>{process.env.OPENAI_PROVIDER ?? "mock"}</dd>
          </div>
          <div>
            <dt>Research model</dt>
            <dd>
              {openAIEnabled
                ? (process.env.OPENAI_RESEARCH_MODEL ??
                  DEFAULT_OPENAI_RESEARCH_MODEL)
                : "deterministic-mock"}
            </dd>
          </div>
          <div>
            <dt>Fast model</dt>
            <dd>
              {openAIEnabled
                ? (process.env.OPENAI_FAST_MODEL ?? DEFAULT_OPENAI_FAST_MODEL)
                : "deterministic-mock"}
            </dd>
          </div>
          <div>
            <dt>Mail provider</dt>
            <dd>{process.env.MAIL_PROVIDER ?? "mock"}</dd>
          </div>
          <div>
            <dt>Workflow provider</dt>
            <dd>{process.env.WORKFLOW_PROVIDER ?? "mock"}</dd>
          </div>
        </dl>
        <p className="muted">Secret values are never rendered.</p>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Microsoft & mailbox connections</h2>
          <a
            className="button-link"
            href="/api/integrations/microsoft/authorize"
          >
            Connect Microsoft 365
          </a>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mailbox</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Scopes</th>
                <th>Last sync</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((mailbox) => (
                <tr key={mailbox.id}>
                  <td>{mailbox.email}</td>
                  <td>{mailbox.provider}</td>
                  <td>
                    <span className="badge">{mailbox.status}</span>
                  </td>
                  <td>{mailbox.grantedScopes.join(", ") || "Local mock"}</td>
                  <td>{mailbox.lastSyncedAt?.toLocaleString() ?? "Never"}</td>
                  <td>
                    <div className="header-actions">
                      {mailbox.provider === "microsoft_graph" ? (
                        <>
                          <form
                            action="/api/operator/commands/sync-mailbox"
                            method="post"
                          >
                            <input
                              type="hidden"
                              name="csrf"
                              value={session.csrfToken}
                            />
                            <input
                              type="hidden"
                              name="mailboxId"
                              value={mailbox.id}
                            />
                            <button className="button-secondary">
                              Sync now
                            </button>
                          </form>
                          <form
                            action="/api/operator/commands/disconnect-mailbox"
                            method="post"
                          >
                            <input
                              type="hidden"
                              name="csrf"
                              value={session.csrfToken}
                            />
                            <input
                              type="hidden"
                              name="mailboxId"
                              value={mailbox.id}
                            />
                            <button className="button-danger">
                              Disconnect
                            </button>
                          </form>
                        </>
                      ) : (
                        <span>Development mailbox</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Sending policy</h2>
        <form
          action="/api/operator/commands/update-settings"
          method="post"
          className="form-grid"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <label className="check warning">
            <input
              type="checkbox"
              name="emergencyPause"
              defaultChecked={settings.emergencyPause}
            />
            Emergency pause
          </label>
          <label>
            Timezone
            <input name="timezone" defaultValue={settings.timezone} />
          </label>
          <fieldset className="span-all">
            <legend>Working days</legend>
            <div className="check-row">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, index) => (
                  <label className="check" key={day}>
                    <input
                      type="checkbox"
                      name="workingDays"
                      value={index}
                      defaultChecked={settings.workingDays.includes(index)}
                    />
                    {day}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          <label>
            Start minute
            <input
              name="workingStartMinute"
              type="number"
              min={0}
              max={1439}
              defaultValue={settings.workingStartMinute}
            />
          </label>
          <label>
            End minute
            <input
              name="workingEndMinute"
              type="number"
              min={1}
              max={1440}
              defaultValue={settings.workingEndMinute}
            />
          </label>
          <label>
            Mailbox daily cap
            <input
              name="mailboxDailyCap"
              type="number"
              min={1}
              defaultValue={settings.mailboxDailyCap}
            />
          </label>
          <label>
            Campaign daily cap
            <input
              name="campaignDailyCap"
              type="number"
              min={1}
              defaultValue={settings.campaignDailyCap}
            />
          </label>
          <label>
            Mailbox minimum delay (seconds)
            <input
              name="mailboxMinimumDelaySeconds"
              type="number"
              min={0}
              defaultValue={settings.mailboxMinimumDelaySeconds}
            />
          </label>
          <label>
            Contact minimum delay (minutes)
            <input
              name="contactMinimumDelayMinutes"
              type="number"
              min={0}
              defaultValue={settings.contactMinimumDelayMinutes}
            />
          </label>
          <label>
            Cross-campaign cooldown (days)
            <input
              name="crossCampaignCooldownDays"
              type="number"
              min={0}
              defaultValue={settings.crossCampaignCooldownDays}
            />
          </label>
          <button>Save sending policy</button>
        </form>
      </section>
      <section className="panel">
        <h2>Suppression list</h2>
        <form
          action="/api/operator/commands/add-suppression"
          method="post"
          className="inline-form"
        >
          <input type="hidden" name="csrf" value={session.csrfToken} />
          <label>
            Scope
            <select name="scope">
              <option value="email">Email</option>
              <option value="domain">Domain</option>
            </select>
          </label>
          <label>
            Value
            <input name="value" required />
          </label>
          <label>
            Reason
            <select name="reason">
              <option value="manual">Manual</option>
              <option value="legal">Legal</option>
              <option value="unsubscribe">Confirmed unsubscribe</option>
              <option value="hard_bounce">Confirmed hard bounce</option>
            </select>
          </label>
          <label>
            Notes
            <input name="notes" />
          </label>
          <button>Add suppression</button>
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Value</th>
                <th>Reason</th>
                <th>Created</th>
                <th>Remove</th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.scope}</td>
                  <td>{entry.normalizedValue}</td>
                  <td>{entry.reason}</td>
                  <td>{entry.createdAt.toLocaleString()}</td>
                  <td>
                    <form
                      action="/api/operator/commands/remove-suppression"
                      method="post"
                      className="stack compact-form"
                    >
                      <input
                        type="hidden"
                        name="csrf"
                        value={session.csrfToken}
                      />
                      <input type="hidden" name="id" value={entry.id} />
                      {(entry.reason === "unsubscribe" ||
                        entry.reason === "hard_bounce") && (
                        <input
                          name="justification"
                          required
                          placeholder="Verified justification"
                        />
                      )}
                      {entry.reason === "unsubscribe" ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            name="confirmedResubscription"
                            required
                          />
                          Confirmed resubscription
                        </label>
                      ) : null}
                      {entry.reason === "hard_bounce" ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            name="verifiedAddressOverride"
                            required
                          />
                          Address independently verified
                        </label>
                      ) : null}
                      <button className="button-danger" type="submit">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {suppressions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No suppressions.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <details className="panel">
        <summary>Workflow and provider failures</summary>
        <h3>Workflow events</h3>
        {workflows.map((event) => (
          <details className="audit-row" key={event.id}>
            <summary>
              {event.createdAt.toISOString()} {event.workflowName} ·{" "}
              {event.status} · attempt {event.attempt}
            </summary>
            <pre>
              {JSON.stringify(
                {
                  event: event.event,
                  entityType: event.entityType,
                  entityId: event.entityId,
                  runId: event.runId,
                  idempotencyKey: event.idempotencyKey,
                  scheduledAt: event.scheduledAt,
                  startedAt: event.startedAt,
                  completedAt: event.completedAt,
                  payload: event.payload,
                  error: event.error,
                },
                null,
                2,
              )}
            </pre>
          </details>
        ))}
        <h3>Agent runs</h3>
        {runs.map((run) => (
          <details className="audit-row" key={run.id}>
            <summary>
              {run.createdAt.toISOString()} {run.agent}/{run.model} ·{" "}
              {run.status}
            </summary>
            <pre>
              {JSON.stringify(
                {
                  responseId: run.responseId,
                  promptVersion: run.promptVersion,
                  schemaVersion: run.schemaVersion,
                  input: run.input,
                  output: run.output,
                  sources: run.sources,
                  tokenUsage: run.tokenUsage,
                  toolUsage: run.toolUsage,
                  costAvailability: run.costAvailability,
                  costUsd: run.costUsd,
                  startedAt: run.startedAt,
                  completedAt: run.completedAt,
                  error: run.error,
                },
                null,
                2,
              )}
            </pre>
          </details>
        ))}
        <h3>Graph notification receipts</h3>
        {notificationFailures.map((item) => (
          <details className="audit-row" key={item.id}>
            <summary>
              {item.receivedAt.toISOString()} {item.resourceId} · attempts{" "}
              {item.attemptCount}
            </summary>
            <pre>{JSON.stringify(item, null, 2)}</pre>
          </details>
        ))}
      </details>
    </main>
  );
}
