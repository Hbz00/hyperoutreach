# Hyperoutreach

Hyperoutreach is a self-hosted, single-operator prospecting and customer-discovery
tool. It is being built as a modular Next.js monolith with PostgreSQL as the
business-state source of truth. `SPEC.md` is the authoritative product and
architecture specification; `PLAN.md` tracks verified delivery milestones.
The source is provided under the permissive [MIT License](LICENSE).

## Current status

The complete credential-free MVP path is implemented: authenticated operator
UI, prospect research and resolution, immutable campaigns, human review, mock
sending, durable follow-ups, reply ingestion, suppression, and operational
inspection. PostgreSQL migrations, deterministic provider substitutes, and
unit/integration/Playwright coverage are included. Real Microsoft Graph,
OpenAI, and Trigger.dev adapters are implemented and contract-tested; live
provider verification still requires the operator's own credentials.

## Prerequisites

- Node.js 22 or later (the foundation was verified with Node 26.5.0)
- npm 11 or later
- Docker with the standalone/legacy `docker-compose` command

This development machine exposes Docker Compose as `docker-compose` 5.3.1. It
does **not** expose `docker compose`; the npm database scripts deliberately use
the verified legacy binary. PostgreSQL is published only on the loopback
interface (`127.0.0.1:55432`), not on external network interfaces.

## Local setup

```bash
cp .env.example .env.local
npm_config_cache=/private/tmp/hyperoutreach-npm-cache npm ci
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000> and sign in with `OPERATOR_EMAIL` and
`OPERATOR_PASSWORD`. Use a unique password of at least 12 characters and a
random `SESSION_SECRET` of at least 32 bytes outside local development. The
database-backed health endpoint is
<http://localhost:3000/api/health> and returns HTTP 200 only when PostgreSQL is
reachable.

The example environment defaults all external providers to deterministic mock
mode. Replace the session and encryption placeholders before any non-local use.
OpenAI, Microsoft, and Trigger credentials are server-only and intentionally
blank. Never commit `.env` or `.env.local`.

## Operator workflow

- `/prospects` runs ICP account discovery, adds globally deduplicated prospects,
  and exposes shared company research, contact discovery, evidence, and email
  resolution on each detail page.
- `/campaigns` creates, publishes, and revises immutable sequence versions,
  pauses/resumes campaigns, and enrolls resolved prospects.
- `/review` shows the exact persisted subject/body with evidence and confidence,
  then supports approve, edit, reject, send, and due-follow-up reconciliation.
- `/inbox` shows reply classification and sequence outcomes. Mock mail mode also
  exposes a local reply injector through the same ingestion service used by
  Graph.
- `/settings` handles Microsoft OAuth, mailbox operations, sending policy,
  emergency pause, suppression management, and expandable provider/workflow
  audit records.

All mutations re-authenticate the signed session and verify its exact CSRF token.
Health, the Microsoft OAuth callback, and the Graph webhook are public; OAuth
initiation requires either an operator session or the server-side bearer token.
The application bounds failed login attempts per forwarded client address;
operators should still apply a trusted reverse-proxy rate limit for distributed
or multi-process deployments.

Stop the local database without deleting its named volume:

```bash
npm run db:down
```

To remove the volume as well, run `docker-compose down --volumes` explicitly;
that destroys local database data and is therefore not the default script.

## Database workflow

- `npm run db:generate` generates a migration after a schema change.
- `npm run db:migrate` applies the repository-visible migration history.
- `npm run db:check` validates migration-history consistency.
- `npm run db:up` starts PostgreSQL and idempotently provisions the disposable
  `hyperoutreach_test` database, including when the Docker volume already exists.
- `npm run db:seed` idempotently creates the local mock mailbox.
- `npm run test:integration` rebuilds the test database's `public` schema,
  applies the repository-visible migrations through Drizzle, and proves the material
  relational constraints against PostgreSQL. It uses `TEST_DATABASE_URL` rather
  than the application `DATABASE_URL`. Do not point `TEST_DATABASE_URL` at a
  database containing data you need.

Integration tests refuse to start when the test and application URLs are equal,
when they name the same database through different connection URLs, or when the
test database name does not end in `_test`. The checked-in defaults use separate
`hyperoutreach` and `hyperoutreach_test` databases on the same local server.

The schema records accounts, contacts, evidence, email candidates, campaigns and
immutable versions, sequence steps, mailboxes, enrollments, messages, inbound
deduplication records, replies, suppressions, workflow events, agent runs, and
state transitions. Explicit enums represent lifecycle state. Unique/partial
indexes and composite foreign keys prevent the key duplicate cases without
conflating same-name accounts with different domains or same-name contacts with
different LinkedIn identities. Evidence belongs to exactly one account or
contact and is URL-deduplicated within that owner. Database triggers make
campaign versions and their steps immutable after an enrollment uses them.
Historical `used_at` state remains after enrollment deletion, and an enrollment's
campaign, version, and contact identity cannot be repinned after insert;
operational state and mailbox assignment remain updateable. Tables with an
`updated_at` column advance it automatically on update.

## Discovery, research, and email resolution

Narrow account-discovery, account-research, contact-discovery,
personalization, and reply-classification agents share a strict structured-output
boundary. The real implementation uses OpenAI's Responses API, current
`web_search`, and Zod-derived strict JSON schemas. It never falls back silently
when `OPENAI_PROVIDER=openai`: `OPENAI_API_KEY` is then required. Research and
fast-model defaults are `gpt-5.6-terra` and `gpt-5.6-luna`; both are configurable.

Credential-free development uses deterministic mock agents through the same
interfaces. Each persisted operation records agent/model/prompt/schema versions,
structured input/output, Responses ID, sources, detailed token/cache/reasoning
usage, web-search call count, cost availability/value, completion state, and
sanitized failures in `agent_runs`. Only HTTP(S) URLs observed in the actual
Responses web-search source payload can support model claims. Account research
has a configurable freshness TTL, a crash-recoverable ownership claim that avoids
duplicate concurrent calls, and one snapshot reused by every contact. A global
LinkedIn identity only changes employers when current-employment evidence is
validated; otherwise the result remains an explicit manual conflict. Evidence
retrieval time is server-observed and repeated source URLs refresh provenance.
A validated move increments an employment version, rejects prior email candidates,
resets email resolution, and stops earlier nonterminal enrollments. Outbound
messages are pinned to the account/employment version and sending shares the
contact action lock with moves through provider acceptance, so an old-company
recipient cannot be sent after a committed move.

Personalization does not invoke web search. Its evidence URLs must instead be in
the explicit trusted-source allowlist supplied with persisted account research;
provider output cannot introduce a new URL.

Email resolution obtains public examples through a provenance-bearing
`PublicEmailEvidenceProvider`; the real adapter uses Responses web search and
binds every structured sample to an observed HTTP(S) source. It ignores examples
from other domains, excludes samples ambiguous across multiple conventions,
deterministically infers supported address conventions, normalizes international
names, and performs replaceable real/mock MX checks. RFC null MX means the domain
does not accept mail; any MX only affects confidence and never proves that a
recipient exists. Below the confidence threshold, an optional
`EmailEnrichmentProvider` can add candidates;
no-result and transient-failure outcomes remain explicit instead of inventing an
address. DNS, public-evidence, enrichment, and OpenAI operations are abortable and
deadline-bound. A claim fenced by contact/account/domain/employment version keeps
late old-employer results from persisting. PostgreSQL permits at most one accepted
address per contact, and later resolutions replace it transactionally. Contacts
durably retain a typed outcome reason (including missing domain,
insufficient evidence, missing MX, provider failure, or candidate conflict) for UI
and operational inspection. SMTP recipient probing is not used.

Inbound reconciliation reuses the classification and agent-run identity already
persisted on unmatched or ambiguous replies. Repeated scans and later thread
rematches therefore do not rerun the classifier or create orphaned audit rows.

## Microsoft 365 integration

Set `MAIL_PROVIDER=microsoft_graph`, then register a Microsoft Entra web
application whose redirect URI exactly matches `MICROSOFT_REDIRECT_URI`. Grant
delegated `Mail.ReadWrite` and `Mail.Send`; the former is required to create and
retrieve the persisted draft, while the latter sends it. OAuth also asks for
`openid profile email offline_access`. No directory-wide application permission
is used.

Generate a 32-byte encryption key and assign it a stable ID:

```bash
openssl rand -base64 32
# TOKEN_ENCRYPTION_ACTIVE_KEY_ID=prod-v1
# TOKEN_ENCRYPTION_KEYS=prod-v1:<generated value>
```

To rotate keys, add `prod-v2:<new value>` to the comma-separated keyring, switch
the active ID to `prod-v2`, and retain `prod-v1` until stored secrets have been
read and re-encrypted. Refresh and access tokens are AES-256-GCM encrypted at
rest. OAuth state is hashed; its encrypted PKCE verifier expires and becomes
single-use after callback consumption. Upstream response bodies and secrets are
not included in application errors.

Set `OPERATOR_API_TOKEN` to a random value of at least 32 characters. Start a
connection from `/settings`, or call authenticated
`GET /api/integrations/microsoft/authorize` using
`Authorization: Bearer <OPERATOR_API_TOKEN>`. The route rejects unauthenticated
initiation and binds the callback to a short-lived HttpOnly browser cookie as
well as the hashed, single-use OAuth state. Configure the public
HTTPS notification URL as `/api/webhooks/microsoft`. That route echoes Microsoft's
plain-text endpoint challenge and constant-time compares each `clientState`.
Subscriptions request immutable IDs, expire in under seven days, and can be
created, renewed, and deleted by the mailbox services. Lifecycle events are
audited and executed for renewal, recreation, and delta recovery. Validated
webhook deliveries are persisted and acknowledged before Graph retrieval or
classification; claimed background reconciliation has stale-claim recovery.
Inbox delta pagination starts from a persisted five-minute-overlap anchor and
saves only a completed `@odata.deltaLink` after every item is durable; `410` or
`syncStateNotFound` triggers a safe rebaseline. Absolute continuation links are
confined to the configured Graph origin/version path. Webhook and delta messages
enter the same idempotent inbound path.

Configure a one-minute scheduler (host cron, platform cron, or an equivalent
durable scheduler) to call `POST /api/internal/microsoft/reconcile` with
`Authorization: Bearer <OPERATOR_API_TOKEN>`. This database-backed recovery
executor renews subscriptions, reclaims crashed webhook/lifecycle work, and runs
Inbox delta reconciliation even when no later webhook arrives. The webhook's
post-response worker is only a latency optimization; correctness does not depend
on it.

Outbound mail creates an immutable-ID Graph draft with `X-Outreach-ID`, persists
the draft identity before sending, treats Graph's `202 Accepted` as uncertain,
and confirms the message through its immutable Sent Items identity. The provider
is bound to one mailbox. Mock mode follows the same mail contract without
Microsoft credentials.

Live Graph behavior has not been verified in this checkout because no Microsoft
credentials are present. The remaining live smoke check is to connect a test
mailbox through a public HTTPS callback, create and renew its subscription, send
one approved message to a controlled recipient, confirm its immutable Sent Items
identity, reply, and verify both webhook and delta ingestion.

## Durable workflows

`WORKFLOW_PROVIDER=mock` is the credential-free default. It uses the same strict
task payloads and application services as production, records dispatch and every
executor attempt in PostgreSQL, and relies on database constraints, claims, and
expected schedule tokens for idempotency. It does not make in-memory workflow
state authoritative. Local dispatch ownership uses a renewable database lease;
an abandoned `started` dispatch is reclaimed after the lease expires, while an
active executor refreshes ownership and completion is fenced to its run ID.
The application mock mail provider also reconstructs deterministic draft and
delivery identities from PostgreSQL, so a process restart between draft
persistence and send does not strand the local workflow.

For a long-running local/self-hosted installation, call the authenticated
`POST /api/internal/workflows/reconcile` endpoint once per minute from the host
scheduler. It executes recovery synchronously in mock/local mode and dispatches
the durable recovery task in Trigger mode. Repeated calls in the same minute are
persistently deduplicated.

For Trigger.dev Cloud, create a project, set `WORKFLOW_PROVIDER=trigger`,
`TRIGGER_PROJECT_REF`, and the server-only `TRIGGER_SECRET_KEY`, then run:

```bash
npm run trigger:dev
# after validating the development runs
npm run trigger:deploy
```

The pinned SDK/CLI version is 4.5.10. `trigger.config.ts` uses the Node 22 runtime
and the checked-in `trigger/` directory. Declarative schedules scan due
follow-ups every minute and run Graph/subscription and stale-work recovery every
five minutes. Account discovery/research, contact discovery, email resolution,
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

## Validation

With PostgreSQL running and migrated:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run eval
npm run build
```

`npm run eval` loads the schema-validated, versioned fixture at
`evals/fixtures/v1.json`. It reports account/contact precision, required-fact
evidence support, email address/confidence/reason accuracy, labelled
personalization acceptance, reply/state/suppression outcomes, deterministic
send-policy decisions, and duplicate-normalization outcomes. Evidence support
counts only exact URL–fact pairs present in the independently labelled expected
set; a model's own `supports` declaration cannot validate itself. Every metric has a
fixture-declared threshold; the process exits nonzero if any one regresses. The
fixture is deliberately credential-free and contains frozen structured output
shapes plus synthetic expected judgments, so it is reproducible in CI. When
comparing a new model or prompt, create a new versioned fixture (do not rewrite
prior ground truth), replace its predicted/observed fields with captured
schema-valid outputs from an independently human-labelled dataset, review the
acceptance labels, and declare new thresholds explicitly.

The bundled `v1` data contains 100 explicit synthetic captured-output cases. It
is a contract/regression baseline, not a claim of real-world model quality. It
proves the measurement and regression machinery without network credentials.
Production calibration still requires a separate dataset of roughly 100 real
prospects whose company, person, role, email, evidence, and personalization are
manually verified, followed by capturing each model/prompt candidate's
structured outputs into a new immutable fixture version.

Install the pinned Playwright browser once and run the critical workflow tests:

```bash
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hyperoutreach-playwright npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hyperoutreach-playwright npm run test:e2e
# On a host that permits Chromium, include the actual rendered interaction test:
RUN_BROWSER_E2E=1 PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hyperoutreach-playwright npm run test:e2e
```

The Playwright configuration builds and serves the production application rather
than using the development watcher, which makes the test closer to deployment
behavior and avoids low file-descriptor limits on some machines. It never reuses
an existing server, force-selects all mock providers, and provisions only the
disposable `hyperoutreach_e2e_test` database, resetting its schema on every run,
so tests cannot send through or mutate a configured live installation.

The opt-in page-driven test uses only rendered forms, links, and buttons to encode
the complete create/dedupe/research/evidence/resolve/campaign/enroll/review/send/
follow-up/reply/stop/suppress/blocked-send lifecycle. A real Chromium run exposed
and drove the fix for a cross-host authentication redirect (`127.0.0.1` cookie
followed by `localhost`). UI redirects are now relative, the server is explicitly
bound to `127.0.0.1`, and E2E credentials come from one forced shared fixture.
The full post-fix rendered lifecycle passed in Chromium in 8.3 seconds.

## Architecture boundaries

- `src/app` contains the App Router UI and HTTP endpoints.
- `src/modules` contains domain behavior; normalization begins under
  `src/modules/prospects`.
- `trigger` contains Trigger.dev entrypoints only; task behavior remains in
  `src/modules`.
- `src/lib/db` contains the Drizzle schema and server-only database connection.
- `scripts` contains explicit migration and seed entry points.
- `drizzle` contains the repository-visible SQL migration history.
- `tests/unit`, `tests/integration`, and `tests/e2e` separate deterministic,
  PostgreSQL, and browser verification.

PostgreSQL owns business state. Trigger.dev and the local dispatcher execute
durable work but do not become the source of truth. AI, mock-mail, and Microsoft
Graph implementations sit behind narrow adapters; deterministic application
policy remains the authority for sending, retrying, deduplication, and
suppression.

## Known deviations and live-service boundary

- Initial work was performed without a Git worktree because the repository had
  no commit at that time. It now has a `main` HEAD tracking `origin/main`; a fresh
  filesystem export excluding dependencies, build output, local environment
  files, and test artifacts passed `npm ci`, formatting, lint, typecheck,
  unit/integration tests, eval, migration-history validation, Trigger task
  import, and production build.
- Live OpenAI, Microsoft Graph, and Trigger.dev behavior is not claimed as
  verified. The real OpenAI and Microsoft Graph adapters are contract-tested
  without network access; live checks still require explicitly supplied
  credentials and, for Graph notifications, a public HTTPS endpoint. The
  Trigger.dev task module and dispatcher contract are tested locally, but cloud
  execution/deployment still needs a configured project. Mock mode keeps the
  entire application credential-free.
- The full credential-free critical lifecycle is verified through rendered
  Chromium as documented above. Live provider smoke checks remain separate.
- A full development-dependency `npm audit` retains five moderate findings in
  legacy `esbuild` versions pulled by the pinned current Trigger.dev and Drizzle
  CLIs; npm reports no compatible fix for those chains. They are not shipped in
  the production dependency tree (`npm audit --omit=dev` reports zero findings).
  A lockfile override to `tar` 7.5.22 removes the high/critical archive findings
  that those development tools otherwise inherited.
