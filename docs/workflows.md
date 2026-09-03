# Durable workflows

[← Back to the README](../README.md)

`WORKFLOW_PROVIDER=local` is the credential-free default. The legacy value
`mock` remains a compatibility alias for this same local executor; it does not
select mock AI. The local executor uses the same strict
task payloads and application services as production, records dispatch and every
executor attempt in PostgreSQL, and relies on database constraints, claims, and
expected schedule tokens for idempotency. It does not make in-memory workflow
state authoritative. Local dispatch ownership uses a renewable database lease;
an abandoned `started` dispatch is reclaimed after the lease expires, while an
active executor refreshes ownership and completion is fenced to its run ID.
The application mock mail provider also reconstructs deterministic draft and
delivery identities from PostgreSQL, so a process restart between draft
persistence and send does not strand the local workflow.

In local mode, the normal `npm run dev` and `npm start` commands start the
maintenance worker automatically. Each owned cycle executes and audits this
safety-critical order:

1. reconcile every available non-mock inbound mailbox and ingest/classify
   matched replies;
2. reconcile due follow-ups;
3. recover stale work, which also dispatches the sends the operator scheduled
   for a later legal instant;
4. drain the operator command queue — the research, discovery, resolution and
   generation work a page asked for, run here rather than inside the request.

The command queue is last on purpose: it is the only stage whose duration the
operator chooses, and the three ahead of it keep the mailbox, the sequence and
the send queue moving on every tick regardless. It spends at most one AI turn
per cycle, because that turn holds the operator's single ChatGPT window.

Whether a command spent that turn is **observed, not predicted**: every path to
the window records an `agent_runs` row before it calls the provider, so the queue
counts those rows around each command and stops the pass when one appears. It used
to answer from the task name instead, which was wrong in the three cases that
matter — a resolution reusing a company search already on record, account research
reusing a fresh snapshot, and a deterministic generation all ask the model nothing
— and that guess is what made ten colleagues at one company take ten minutes for an
answer established once. The count is a delta rather than a timestamp comparison
because the row's clock is the database's and the command's is the process's; a
database a second behind would hide a turn, which is the one direction this bound
cannot afford to fail in.

An inbound failure stops the cycle before any due send. Mailbox health also
remains a deterministic send-policy gate. A process-local guard makes the next
minute tick a neutral `busy` no-op while a long request is still running, and a
singleton PostgreSQL lease prevents overlap across processes. Neither guard
changes business state ownership: PostgreSQL remains authoritative.

The narrow commands are intended for diagnostics and infrastructure-managed
deployments:

```bash
npm run dev:web          # Next.js only, without the supervisor
npm run start:web        # production Next.js only
npm run maintenance:local # standalone local worker
```

Set `LOCAL_MAINTENANCE_ENABLED=false` to opt out explicitly while retaining
`npm run dev` or `npm start`; the supervisor prints one startup notice and runs
only Next.js. `WORKFLOW_PROVIDER=trigger` also starts only Next.js because
Trigger.dev owns scheduling. In local mode, the worker origin defaults to
`http://127.0.0.1:${PORT:-3000}`. `PORT` must be set in the environment that
launches npm; a `PORT` value in `.env.local` is intentionally ignored for
process binding. `LOCAL_MAINTENANCE_BASE_URL` can override the origin with an
absolute HTTP(S) URL for a proxy or container topology.

While local maintenance is enabled, pass the Next port through `PORT=4100 npm
run dev`, not `npm run dev -- --port 4100` or `-p`: the supervisor rejects
Next.js CLI port flags so the server and worker cannot silently select different
origins. The authenticated `POST /api/internal/workflows/reconcile` endpoint is
still available for a deliberate one-shot diagnostic:

```bash
node --input-type=module <<'NODE'
import { loadAndResolveLocalMaintenanceConfig } from "./scripts/local-maintenance-runtime.mjs";

const config = loadAndResolveLocalMaintenanceConfig();
if (config.mode !== "enabled") {
  throw new Error("This diagnostic requires enabled local maintenance");
}
try {
  const response = await fetch(config.maintenanceUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    console.error(`Maintenance diagnostic failed with HTTP ${response.status}`);
    process.exitCode = 1;
  } else {
    console.log(`Maintenance diagnostic completed with HTTP ${response.status}`);
  }
} catch {
  console.error(
    `Maintenance diagnostic request failed or timed out after ${config.requestTimeoutMs}ms`,
  );
  process.exitCode = 1;
}
NODE
```

This local-mode diagnostic uses the same `.env*`, launch-process `PORT`, URL,
and token resolution and bounded request timeout as the production worker. The
token stays out of the command arguments and output, and transport failures do
not print raw provider errors. The request is not the normal scheduler and may
return a deduplicated or neutral busy outcome when another cycle owns the minute
or database lease. When diagnosing a production `npm start` process, invoke the
same snippet with `NODE_ENV=production node --input-type=module` so Next's
production `.env*` selection is preserved.

Settings and `/outbound` both show the persisted maintenance projection —
Settings as configuration state, `/outbound` because everything on that page is
executed by the cycle and a queue that is merely slow must be distinguishable
from one that is dead. Both read the same resolver and the same sanitized
failure text; neither exposes the lease owner token. The six states are:

- **Not started** — no cycle has ever been recorded;
- **Running** — a cycle owns the lease and its heartbeat is current;
- **Stalled** — an owner remains but its heartbeat is stale;
- **Failed** — the latest failure is newer than the latest success;
- **Overdue** — no cycle is active and the last success is outside the expected
  window;
- **Healthy** — no cycle is active and the last success is recent.

`Running` is distinct from `Overdue`: a normal long AI cycle remains running
while its heartbeat is current. The no-owner overdue window is the greater of
`AI_RESEARCH_TIMEOUT_MS + 60 seconds` and three maintenance intervals (eleven
minutes with the default 600-second research deadline). Settings also shows the automation
provider/mode, active-cycle timestamps when applicable, the last success, and a
sanitized historical failure without exposing the lease token or credentials.

`config/maintenance.json` carries the cycle's timings. `intervalMs`,
`heartbeatIntervalMs`, `staleLeaseMs`, `aggregateBudgetMs`, `transportMarginMs`
and the two shutdown grace values are read at runtime. `stageMaximumsMs` is
not: it records how `aggregateBudgetMs` was derived from the four stages, and
changing it alone changes nothing.

For Trigger.dev Cloud, create a project, set `WORKFLOW_PROVIDER=trigger`,
`TRIGGER_PROJECT_REF`, and the server-only `TRIGGER_SECRET_KEY`, then run:

```bash
npm run trigger:dev
# after validating the development runs
npm run trigger:deploy
```

The pinned SDK/CLI version is 4.5.10. `trigger.config.ts` uses the Node 22 runtime
and the checked-in `trigger/` directory. One aggregate `maintenance-cycle`
schedule runs every minute and preserves the same inbound → due follow-up →
stale recovery order and fail-closed behavior as local mode. The narrow inbound,
due-follow-up, and stale-recovery tasks remain callable for explicit recovery
and testing but are not independently scheduled. Graph subscription maintenance
keeps its separate five-minute schedule. Account discovery/research, contact
discovery, email resolution,
personalization, deterministic generation, approved sending, sequence advance,
webhook drain, and delta reconciliation also have narrow task entrypoints.

Trigger idempotency is an executor optimization, not the send guarantee. Backend
dispatch creates explicitly global keys; PostgreSQL still owns message/enrollment
state, unique step sends, claims, `next_action_at`, and `next_action_token`.
Every task validates its payload, records Trigger/local run ID and attempt, and
then calls the same application service used in local mode. Duplicate/stale runs
therefore either reuse durable state or no-op. Resolved service outcomes are
classified deterministically: transient provider/agent/database outcomes fail
the task so bounded Trigger retries apply, while policy blocks, stale work, and
delivery uncertainty remain terminal/no-op outcomes so retries cannot bypass
policy or risk a duplicate send. The recovery task reclaims expired
research/resolution claims, uncertain sends, inbound classification, and due
follow-ups after executor downtime. Each scheduled recovery tick uses small,
independently bounded work classes, reserving message capacity for actionable
drafts/sends so old uncertain deliveries cannot starve newer work or overrun the
task duration. Uncertain reconciliation advances a persisted ordering cursor on
each scan so a poison item cannot monopolize that reserved capacity.

The Graph webhook persists notifications before acknowledging them, then asks
the selected workflow dispatcher to drain staged work. Delta and lifecycle
maintenance remain the correctness backstop if that low-latency dispatch is
missed.

Live Trigger deployment has not been verified in this checkout because no
Trigger credentials are present. The task module itself is import/type checked;
the remaining live check is `npm run trigger:dev`, invoke each task in the
development environment, inspect its PostgreSQL `workflow_events`, then perform
a dry-run and production deploy.
