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
follow-ups and stale-work recovery. In Trigger mode the existing Trigger.dev
schedules remain authoritative and no local scheduler may compete with them.

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

1. validate the maintenance configuration before starting;
2. start Next.js and wait for its health endpoint;
3. start the worker only in local workflow mode when maintenance is enabled;
4. forward `SIGINT` and `SIGTERM` and reap both children;
5. terminate the sibling and exit non-zero if either required child exits
   unexpectedly;
6. avoid runtime TypeScript dependencies so `npm start` works with a
   production-only dependency installation.

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

PostgreSQL remains the cross-process safety boundary. Existing minute-scoped
idempotency keys, workflow leases, claims, send policy, and relational
constraints protect restarts and accidental duplicate workers. The in-process
guard reduces needless work; it is not the source of truth.

The local maintenance route preserves the safety-critical order:

1. reconcile every available inbound mailbox;
2. ingest and classify matched replies;
3. reconcile due follow-ups;
4. recover stale work.

If inbound mailbox reconciliation fails, later stages do not run. The worker
records the failed HTTP cycle, reports one concise sanitized error, and retries
on a later offered tick. It does not bypass the inbox health gate.

## Status in Settings

The initial scope adds status only to Settings, not to the dashboard.

The status is derived from persisted `workflow_events`, never solely from
worker memory:

- `not started`: no aggregate local maintenance execution exists;
- `running`: a maintenance task is `started` and has a fresh dispatcher
  heartbeat;
- `healthy`: no task is running and the latest cycle completed recently;
- `failed`: the latest completed cycle failed and no newer cycle is running;
- `overdue`: no cycle is running and no successful cycle completed within the
  allowed window.

An active cycle must display as `running` even when it exceeds one minute. It
must not become `overdue` merely because Codex is still classifying an inbound
reply.

The no-active-cycle overdue window is:

```text
max(CODEX_TIMEOUT_MS + 60 seconds, 3 * maintenance interval)
```

With `CODEX_TIMEOUT_MS=240000` and a one-minute interval, this is five minutes.
The running state uses the durable dispatcher heartbeat. A stale heartbeat may
be reported as failed/overdue rather than indefinitely running.

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
7. the worker waits for health before its first maintenance request;
8. signal handling terminates and reaps both children;
9. an unexpected required-child exit terminates the sibling and returns
   non-zero;
10. a cycle longer than one minute makes the following offered tick a no-op
    without error and never raises concurrency above one;
11. a later tick runs after the long cycle completes;
12. local execution preserves inbound -> due follow-up -> recovery order;
13. an inbound failure prevents the due-follow-up dispatch;
14. repeated/restarted cycles remain database-idempotent;
15. Settings distinguishes not-started, running, healthy, failed, and overdue;
16. running longer than a minute remains running, including a duration below
    the Codex-aware stale window;
17. Playwright uses its isolated database and explicitly disables the worker
    except for a dedicated maintenance integration scenario;
18. a real local SMTP/IMAP smoke after restart records a successful aggregate
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
- the local dispatcher persists idempotency keys, renews a lease heartbeat, and
  owner-fences completion;
- maintenance tasks can run for up to several minutes and Codex is configured
  for 240 seconds, so a fixed two-minute overdue alert would be incorrect;
- the current local maintenance route already awaits inbound reconciliation
  before dispatching due follow-ups.

## Non-goals

- replacing Trigger.dev;
- adding a custom distributed queue or cron engine;
- running maintenance in the browser;
- adding the maintenance indicator to the dashboard in this iteration;
- automatically sending, approving, or enabling campaign follow-ups;
- changing provider credentials or mailbox configuration.
