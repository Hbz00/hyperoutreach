# Local Maintenance Worker Design

Date: 2026-08-14

Status: approved by the operator, pending implementation

## Problem

Trigger.dev owns the production schedules when `WORKFLOW_PROVIDER=trigger`, but
the self-hosted local mode currently requires an external scheduler to call
`POST /api/internal/workflows/reconcile` once per minute. The route and all
database-backed workflow protections already exist, but `npm run dev` and
`npm start` launch only Next.js. A foreground shell loop is useful for a smoke
test, not an acceptable end-to-end operating model.

This gap affects every time-driven local workflow. It is most visible for
SMTP/IMAP because inbound mail has no webhook, but it also affects due
follow-ups and stale-work recovery. The current Trigger implementation also has
separate same-minute inbox and follow-up schedules, which do not guarantee the
required inbox-before-send order. Both providers therefore need one aggregate
maintenance-cycle boundary even though only local mode needs a resident worker.

## Decision

Add a dedicated local maintenance worker and a small process supervisor. In
local workflow mode, the normal development and production commands start the
Next.js server and the worker together. In Trigger mode, they start only the
Next.js server because Trigger.dev already owns the schedules.

Do not start a timer from `instrumentation.ts` or another Next.js module.
Instrumentation is an observability lifecycle hook, and hot reload or multiple
server instances could create duplicate timers with unclear shutdown behavior.

Keep the authenticated maintenance route as the single application entrypoint.
The worker calls that route rather than duplicating workflow construction or
business logic.

Introduce one aggregate `maintenance-cycle` workflow task shared by local and
Trigger execution. It owns the safety-critical sequence. Replace the separate
Trigger inbox and due-follow-up cron ownership with one scheduled aggregate
task; keep narrow tasks callable for explicit recovery and testing, but do not
schedule them independently.

## Commands and process lifecycle

The public commands become:

```text
npm run dev
  -> supervisor
     -> Next.js development server
     -> local maintenance worker when WORKFLOW_PROVIDER=local

npm start
  -> supervisor
     -> Next.js production server
     -> local maintenance worker when WORKFLOW_PROVIDER=local
```

Narrow commands remain available for diagnostics and infrastructure-managed
deployments:

```text
npm run dev:web
npm run start:web
npm run maintenance:local
```

The supervisor must:

1. load the same `.env*` files as Next.js via `@next/env/loadEnvConfig`, then
   validate the maintenance configuration before starting;
2. start Next.js and wait for its health endpoint;
3. start the worker only in local workflow mode when maintenance is enabled;
4. forward `SIGINT` and `SIGTERM` and reap both children;
5. terminate the sibling and exit non-zero if either required child exits
   unexpectedly;
6. avoid runtime TypeScript dependencies so `npm start` works with a
   production-only dependency installation.

`@next/env` is a direct production dependency because the supervisor and worker
run outside Next.js. The supervisor passes the resolved environment unchanged
to both children. `PORT` is the exception: capture it from the launching process
before loading `.env*`, because Next.js requires its boot port to be a process
environment value rather than a value from `.env`. Validate it as an integer
from 1 through 65535.

`LOCAL_MAINTENANCE_ENABLED=false` is an explicit diagnostic opt-out. It is not
the default. The supervisor prints one clear startup notice when maintenance is
disabled.

When local maintenance is enabled, a missing or shorter-than-32-character
`OPERATOR_API_TOKEN` is a startup configuration error. The supervisor fails
once with an actionable message. It must not start a worker that emits an
authentication error every minute, and it must not silently leave a live local
installation without inbox reconciliation.

## Worker URL

The default internal origin is derived from the standard Next.js port:

```text
http://127.0.0.1:${PORT || 3000}
```

`LOCAL_MAINTENANCE_BASE_URL` may explicitly override this origin for a reverse
proxy, container, or non-default bind topology. The value must be an absolute
HTTP(S) URL. The worker appends the fixed health and maintenance paths itself;
the override cannot change those paths. Credentials are sent only in the
`Authorization` header and are never logged.

## Scheduling and overlap

After the health endpoint succeeds, the worker triggers an immediate cycle and
then offers one tick every 60 seconds. A process-local in-flight guard ensures
that only one HTTP maintenance request can exist at a time. If a cycle takes
longer than one minute, later offered ticks return the neutral `busy` outcome
and do nothing. They are not errors and they do not start overlapping requests.
The next offered tick after completion runs normally.

PostgreSQL remains the cross-process safety boundary. Add a singleton
`maintenance_state` row with an owner token, cycle start, heartbeat, latest
success, latest failure, and sanitized latest error. Claiming, heartbeat,
completion, and release are owner-fenced. Only the current owner may execute a
stage. Another process or a later minute that observes a fresh owner returns the
neutral `busy` result before dispatching any stage. A stale lease can be taken
over atomically. The process-local guard reduces needless HTTP requests; it is
not the source of truth.

Every owned cycle also creates one aggregate `workflow_events` audit record for
historical inputs, output, outcome, attempts, and timing. The singleton row is
the current status/lease projection; the append-only event is the historical
audit. Add a workflow-name/creation-time index for the Settings history query;
the singleton projection itself needs no search index. Minute-scoped idempotency
remains useful, but it is not treated as a cross-minute mutex.

The local maintenance route preserves the safety-critical order:

1. reconcile every available inbound mailbox;
2. ingest and classify matched replies;
3. reconcile due follow-ups;
4. recover stale work.

If inbound mailbox reconciliation fails, later stages do not run. The worker
records the failed HTTP cycle, reports one concise sanitized error, and retries
on a later offered tick. It does not bypass the inbox health gate.

The same aggregate service runs inside the single Trigger.dev schedule. Trigger
therefore preserves the same order and stop-on-inbound-failure behavior rather
than racing two independent cron tasks.

## Request timeout and graceful shutdown

The maintenance HTTP request is bounded. Its budget is derived from the sum of
the existing maintenance task maximum durations plus a one-minute transport and
shutdown margin, and is never less than `CODEX_TIMEOUT_MS + 60 seconds`. This
keeps the timeout aligned with supported AI work while preventing a permanently
hung client request.

The aggregate task and route use the same cycle budget as their maximum
duration. Trigger configuration must permit that per-task duration; it must not
retain the current 300-second ceiling while the aggregate contract allows a
longer cycle.

A client timeout does not release or replace a fresh database owner. The
aggregate lease heartbeat remains authoritative, and a later worker receives
`busy` until the owner completes or the lease becomes stale.

On `SIGINT` or `SIGTERM`, the supervisor first asks the worker to stop offering
new ticks while leaving Next.js alive. It allows an active request a documented
grace period. After the worker finishes, or after that grace period expires and
the client request is aborted, it signals Next.js and allows Next.js its own
graceful-request shutdown period before escalating. Completion remains
owner-fenced if shutdown interrupts a cycle.

## Status in Settings

The initial scope adds status only to Settings, not to the dashboard.

The status is derived from the persisted `maintenance_state` projection and its
aggregate `workflow_events` history, never solely from worker memory. The state
priority is deterministic:

1. `running`: an owner exists with a fresh heartbeat;
2. `not started`: no cycle has ever started;
3. `stalled`: an owner exists but its heartbeat is stale;
4. `failed`: the latest completed outcome is a failure;
5. `overdue`: no owner exists and the latest successful cycle is older than the
   allowed window;
6. `healthy`: no owner exists and the latest successful cycle is recent.

An active cycle must display as `running` even when it exceeds one minute. It
must not become `overdue` merely because Codex is still classifying an inbound
reply.

The no-active-cycle overdue window is:

```text
max(CODEX_TIMEOUT_MS + 60 seconds, 3 * maintenance interval)
```

With `CODEX_TIMEOUT_MS=240000` and a one-minute interval, this is five minutes.
The running state uses the durable aggregate heartbeat. A stale heartbeat is
reported as `stalled`, never indefinitely `running`.

Settings shows the state, latest successful completion, current-cycle start or
heartbeat when applicable, and the latest sanitized failure. It does not expose
tokens, mailbox passwords, provider responses, or raw internal errors.

## Testing strategy

Implementation follows red-green-refactor. Tests cover:

1. local mode starts web and worker;
2. Trigger mode starts web only;
3. explicit maintenance opt-out starts web only and logs one notice;
4. missing/short `OPERATOR_API_TOKEN` fails once before polling;
5. default URL derives from `PORT`;
6. a valid `LOCAL_MAINTENANCE_BASE_URL` overrides the origin and invalid URLs
   fail preflight;
7. `.env.local` is loaded before preflight, while `PORT` comes only from the
   launching process and is range-validated;
8. the worker waits for health before its first maintenance request;
9. signal handling terminates and reaps both children;
10. shutdown during an active cycle honors the worker and Next.js grace periods;
11. an unexpected required-child exit terminates the sibling and returns
    non-zero;
12. a cycle longer than one minute makes the following offered tick a no-op
    without error and never raises concurrency above one;
13. two worker processes and two different minute keys still produce only one
    owned cycle, while every non-owner returns `busy` before any stage;
14. stale aggregate ownership is atomically reclaimed and late owner completion
    is ignored;
15. a request timeout does not clear a fresh database owner;
16. a later tick runs after the long cycle completes;
17. local and Trigger execution preserve inbound -> due follow-up -> recovery
    order through the same aggregate service;
18. an inbound failure prevents the due-follow-up dispatch in both providers;
19. repeated/restarted cycles remain database-idempotent;
20. Settings distinguishes not-started, running, stalled, healthy, failed, and
    overdue with mutually exclusive precedence;
21. running longer than a minute remains running, including a duration below
    the Codex-aware stale window;
22. Playwright uses its isolated database and explicitly sets
    `LOCAL_MAINTENANCE_ENABLED=false`
    except for a dedicated maintenance integration scenario;
23. a real local SMTP/IMAP smoke after restart records a successful aggregate
    inbox reconciliation without sending a message.

The repository's full migration, formatting, lint, type, unit, PostgreSQL
integration, evaluation, production build, and applicable E2E gates remain
required before completion.

## Stress-test findings incorporated

A process-level scheduling simulation used an execution duration 3.75 times
longer than its offered interval. Across ten offers it completed three cycles,
skipped seven busy offers, never exceeded one active execution, and produced no
busy error. This validates the in-flight guard pattern; production tests will
encode the same invariant using injected clocks rather than wall-clock sleeps.

Configuration review also confirmed:

- the current operator route already treats a missing or short API token as
  unconfigured, so preflight can mirror the same minimum length;
- the local dispatcher persists idempotency keys, renews a per-dispatch lease
  heartbeat, and owner-fences completion, but duplicate dispatches do not wait;
  this is why the cycle requires its own singleton owner;
- maintenance tasks can run for up to several minutes and Codex is configured
  for 240 seconds, so a fixed two-minute overdue alert would be incorrect;
- the current local maintenance route awaits inbound reconciliation before
  dispatching due follow-ups within one caller, but the existing minute keys do
  not serialize two callers;
- the current Trigger inbox and follow-up schedules are independent and must be
  replaced by the aggregate scheduled task.

## Non-goals

- replacing Trigger.dev;
- adding a custom distributed queue or cron engine;
- running maintenance in the browser;
- adding the maintenance indicator to the dashboard in this iteration;
- automatically sending, approving, or enabling campaign follow-ups;
- changing provider credentials or mailbox configuration.
