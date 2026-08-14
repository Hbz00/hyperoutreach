# Local Maintenance Worker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start safe, observable, non-overlapping maintenance automatically with the local Next.js process while preserving the same ordered cycle in Trigger.dev.

**Architecture:** A database-owned aggregate maintenance cycle serializes inbox reconciliation, due follow-ups, and stale recovery across processes. A dependency-free Node supervisor starts Next.js plus an HTTP worker only in local mode; Trigger.dev schedules the same aggregate task directly. Settings reads a singleton PostgreSQL projection for operational status.

**Tech Stack:** TypeScript, Node.js ESM, Next.js 16.3, PostgreSQL 17, Drizzle ORM, Trigger.dev 4.5.10, Vitest, Playwright.

**Shared timing contract:** Create `config/maintenance.json` as the single source
of truth: interval 60,000 ms; stage maxima 300 + 180 + 300 seconds; transport
margin 60 seconds; aggregate/request budget 840 seconds; heartbeat 30 seconds;
stale lease 120 seconds; worker shutdown grace 30 seconds; Next shutdown grace
30 seconds. Both TypeScript and Node ESM import this JSON. The request timeout is
`max(840000, CODEX_TIMEOUT_MS + 60000)`. Tests assert route, worker, lease, and
Trigger values cannot drift.

---

## Chunk 1: Durable aggregate cycle

### Task 1: Schema and status projection

**Files:**

- Modify: `src/lib/db/schema.ts`
- Create: generated `drizzle/0026_*.sql` and snapshot
- Create: `config/maintenance.json`
- Create: `src/modules/workflows/maintenance-status.ts`
- Test: `tests/unit/maintenance-status.test.ts`
- Test: `tests/integration/maintenance-cycle.test.ts`
- Modify: `tests/integration/populated-migrations.test.ts`

- [ ] Write unit tests for mutually exclusive `not_started`, `running`, `stalled`, `failed`, `overdue`, and `healthy` states, including `CODEX_TIMEOUT_MS=240000`.
- [ ] Run `npm test -- tests/unit/maintenance-status.test.ts`; expect RED because `@/modules/workflows/maintenance-status` is absent.
- [ ] Add a singleton `maintenance_state` table with owner token, cycle start, heartbeat, latest success/failure/error, timestamps, and `id = 1` constraint.
- [ ] Add the workflow-name/creation-time index required by Settings history.
- [ ] Generate a populated-safe migration that inserts the singleton row idempotently.
- [ ] Implement the pure status resolver with precedence `running -> not_started -> stalled -> failed -> overdue -> healthy` and overdue window `max(CODEX_TIMEOUT_MS + interval, 3 * interval)`.
- [ ] Run `npm test -- tests/unit/maintenance-status.test.ts`; expect GREEN.
- [ ] Run `npm run test:integration -- tests/integration/populated-migrations.test.ts tests/integration/relational-integrity.test.ts`; expect GREEN on clean and populated paths.

### Task 2: Owner-fenced maintenance-cycle service

**Files:**

- Create: `src/modules/workflows/maintenance-cycle-service.ts`
- Modify: `src/modules/workflows/task-contracts.ts`
- Modify: `src/modules/workflows/service-factory.ts`
- Modify: `src/modules/workflows/runtime.ts`
- Modify: `src/modules/workflows/maintenance-service.ts`
- Test: `tests/integration/maintenance-cycle.test.ts`

- [ ] Write PostgreSQL tests proving one owner across two processes/minutes, neutral `busy` for non-owners, heartbeat renewal, stale takeover, and late-owner fencing.
- [ ] Add tests proving strict inbox -> due follow-up -> recovery order and abort after inbound failure.
- [ ] Run `npm run test:integration -- tests/integration/maintenance-cycle.test.ts`; expect RED showing more than one owner or due-follow-up execution before inbox completion.
- [ ] Add the strict `maintenance-cycle` payload and task definition.
- [ ] Implement singleton claim, heartbeat, owner-fenced success/failure, sanitized audit, and sequential service execution.
- [ ] Make the authenticated maintenance endpoint dispatch only the aggregate task.
- [ ] Run `npm run test:integration -- tests/integration/maintenance-cycle.test.ts`; expect GREEN, including a restarted duplicate cycle.
- [ ] Run `npm test -- tests/unit/workflow-dispatcher.test.ts`; expect GREEN.
- [ ] Commit the schema and aggregate cycle as `feat: add durable maintenance cycle` when repository permissions allow.

## Chunk 2: Automatic local process lifecycle

### Task 3: Worker configuration and overlap guard

**Files:**

- Create: `scripts/local-maintenance-runtime.mjs`
- Create: `scripts/local-maintenance-worker.mjs`
- Test: `tests/unit/local-maintenance-runtime.test.ts`
- Modify: `.env.example`

- [ ] Write RED tests for `.env.local` preflight inputs, missing/short token, `PORT` default/range, explicit base URL, Trigger/disabled mode, health wait, and sanitized logs.
- [ ] Write the requested RED fake-clock test where a cycle exceeds one interval and the following tick returns `busy` without error or concurrency above one.
- [ ] Run `npm test -- tests/unit/local-maintenance-runtime.test.ts`; expect RED for missing runtime/config exports.
- [ ] Implement a small pure configuration parser and guarded scheduler in ESM.
- [ ] Implement the worker health wait, immediate tick, fixed one-minute offers, bounded request, signal drain, and no secret logging.
- [ ] Make both `local-maintenance-worker.mjs` and the supervisor call the same `@next/env/loadEnvConfig` preflight before reading configuration; standalone `npm run maintenance:local` must work with `.env.local`.
- [ ] Import `config/maintenance.json` from the worker and use its exact interval, heartbeat/lease assumptions, request budget, and shutdown grace.
- [ ] Run `npm test -- tests/unit/local-maintenance-runtime.test.ts`; expect GREEN.

### Task 4: Next.js/worker supervisor

**Files:**

- Create: `scripts/run-local-stack.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/unit/local-maintenance-supervisor.test.ts`
- Modify: `playwright.config.ts`

- [ ] Write RED child-process contract tests for local, Trigger, opt-out, missing token, unexpected child exit, and graceful shutdown ordering.
- [ ] Run `npm test -- tests/unit/local-maintenance-supervisor.test.ts`; expect RED for missing supervisor/process lifecycle behavior.
- [ ] Add exact production dependency `@next/env@16.3.0` and load Next-compatible `.env*` before preflight while preserving launch-process `PORT` semantics.
- [ ] Add `dev:web`, `start:web`, and `maintenance:local`; make `dev`/`start` use the supervisor and forward Next arguments.
- [ ] Implement health-aware startup, child signal propagation, active-request grace, sibling termination, and non-zero unexpected-exit behavior.
- [ ] Set `LOCAL_MAINTENANCE_ENABLED=false` explicitly in Playwright's isolated environment.
- [ ] Run `npm test -- tests/unit/local-maintenance-supervisor.test.ts`; expect GREEN.
- [ ] Run `npm ci --omit=dev --ignore-scripts` in a temporary clean export, then `node scripts/run-local-stack.mjs --help`; expect imports/preflight to load without `tsx`.
- [ ] Commit worker/supervisor changes as `feat: start local maintenance automatically` when repository permissions allow.

## Chunk 3: Trigger parity and operator visibility

### Task 5: One ordered Trigger schedule

**Files:**

- Modify: `trigger/tasks.ts`
- Modify: `trigger.config.ts`
- Modify: `config/maintenance.json`
- Modify: `tests/unit/workflow-dispatcher.test.ts`
- Modify: `tests/unit/workflow-task-import.test.ts`
- Test: `tests/integration/maintenance-cycle.test.ts`

- [ ] Write RED tests proving there is one minute schedule and no independently scheduled inbox, due-follow-up, or stale-recovery task. `maintain-graph-subscriptions` remains independently scheduled.
- [ ] Run `npm test -- tests/unit/workflow-dispatcher.test.ts tests/unit/workflow-task-import.test.ts`; expect RED because three maintenance stages still own independent schedules.
- [ ] Replace the inbox, due-follow-up, and stale-recovery crons with the aggregate `maintenance-cycle` schedule while keeping all three narrow task entrypoints callable but unscheduled.
- [ ] Import the shared 840-second budget in `trigger.config.ts`, the aggregate task, the HTTP route, and worker timeout calculation.
- [ ] Run `npm test -- tests/unit/workflow-dispatcher.test.ts tests/unit/workflow-task-import.test.ts`; expect GREEN.
- [ ] Run `npm run test:integration -- tests/integration/maintenance-cycle.test.ts`; expect GREEN for both provider paths and inbound failure.

### Task 6: Settings status

**Files:**

- Modify: `src/app/(operator)/settings/page.tsx`
- Modify: `src/app/globals.css` only if existing status classes are insufficient
- Test: `tests/unit/maintenance-status.test.ts`
- Modify: `tests/e2e/critical-operator-flow.spec.ts`

- [ ] Write RED rendering assertions for every maintenance state and ensure the dashboard remains unchanged.
- [ ] Run `npm test -- tests/unit/maintenance-status.test.ts`; expect RED because Settings maintenance presentation is not implemented.
- [ ] Query the singleton projection and render state, latest success, cycle start/heartbeat, and sanitized failure only in Settings.
- [ ] Add a Settings E2E assertion using the isolated database without starting a background worker.
- [ ] Run `npm test -- tests/unit/maintenance-status.test.ts`; expect GREEN for status rendering inputs.
- [ ] Run `CI=1 npm run test:e2e -- tests/e2e/critical-operator-flow.spec.ts`; expect Settings maintenance assertions GREEN and no background-worker mutations.
- [ ] Commit Trigger/Settings changes as `feat: expose ordered maintenance health` when repository permissions allow.

## Chunk 4: Documentation, live smoke, and release gate

### Task 7: Operational documentation and project memory

**Files:**

- Modify: `README.md`
- Modify: `PLAN.md`
- Modify: `.env.example`

- [ ] Document automatic local startup, narrow commands, opt-out, URL override, status semantics, Trigger aggregate schedule, and migration-without-seed live setup.
- [ ] Remove the foreground terminal loop as the recommended operation path; retain a one-shot endpoint call only as diagnostics.
- [ ] Update PLAN truthfully without claiming live send or external cloud verification.
- [ ] Run `npm run format:check && git diff --check`; expect exit 0.

### Task 8: End-to-end verification

**Files:**

- Test only unless a defect is found.

- [ ] Run `npm run db:up`, `npm run test:integration -- tests/integration/maintenance-cycle.test.ts tests/integration/populated-migrations.test.ts`, and `npm run db:check`; expect exit 0 without touching `hyperoutreach_live`.
- [ ] Snapshot live table counts, current emergency-pause value, and due/sending rows. If any due/sending row exists, stop and investigate rather than smoke.
- [ ] Set `emergency_pause=true` in `hyperoutreach_live`, preserving the prior value; record message/workflow-event counts before migration.
- [ ] Run `node --env-file=.env.local -e 'if (new URL(process.env.DATABASE_URL).pathname !== "/hyperoutreach_live") process.exit(1)' && npm run db:migrate`; expect the database assertion and migration 0026 to pass.
- [ ] Verify live business-table counts are unchanged, the singleton maintenance row exists, and no message send event was created.
- [ ] Run focused worker/cycle/status tests, then full format, lint, typecheck, unit, integration, evaluation, and production build gates.
- [ ] Run Playwright with its isolated database and verify no background maintenance mutation leaks into tests.
- [ ] Restart the local stack with the live configuration while emergency pause remains active and verify one automatic SMTP/IMAP maintenance cycle reaches `succeeded` without sending a message.
- [ ] Verify Settings shows the correct live maintenance state and timestamp.
- [ ] Verify a second concurrent/manual tick returns neutral `busy` or persistent duplicate without executing due follow-ups early.
- [ ] Restore the exact prior emergency-pause value only after the no-send assertions pass; if verification fails, leave the pause active and report the blocker.
- [ ] Perform independent code review focused on race safety, shutdown, secrets, provider parity, and migration upgrades; fix material findings test-first and rerun the full gate.
