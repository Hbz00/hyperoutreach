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
unit/integration/Playwright coverage are included. The local Codex CLI adapter
has also been smoke-tested through the real structured research path. Microsoft
Graph, OpenAI Responses, and Trigger.dev adapters are implemented and
contract-tested; their live verification still requires the operator's own
credentials.

## Prerequisites

- Node.js 22 or later (the foundation was verified with Node 26.5.0)
- npm 11 or later
- Docker with the standalone/legacy `docker-compose` command

This development machine exposes Docker Compose as `docker-compose` 5.3.1. It
does **not** expose `docker compose`; the npm database scripts deliberately use
the verified legacy binary. PostgreSQL is published only on the loopback
interface (`127.0.0.1:55432`), not on external network interfaces.

## Real/self-hosted installation (no demo data)

```bash
cp .env.example .env.local
```

Stop here and replace every public placeholder in `.env.local` before running
the application. This is a mandatory configuration gate, not an optional
hardening step:

- set a unique `OPERATOR_PASSWORD` of at least 12 characters;
- generate independent random values for `OPERATOR_API_TOKEN` (at least 32
  characters) and `SESSION_SECRET` (at least 32 bytes);
- configure a valid AES-256-GCM keyring with a base64-encoded 32-byte key in
  `TOKEN_ENCRYPTION_KEYS` and its matching ID in
  `TOKEN_ENCRYPTION_ACTIVE_KEY_ID`;
- verify `DATABASE_URL`, `TEST_DATABASE_URL`, and the selected AI, mail, and
  workflow provider settings for this installation.

The checked-in secret values are deliberately invalid and must never be used as
credentials. Keep generated values only in the uncommitted `.env.local` or a
secret manager; do not paste them into commands, logs, issues, or documentation.
Only after completing that gate, install and start the application:

```bash
npm_config_cache=/private/tmp/hyperoutreach-npm-cache npm ci
npm run db:up
npm run db:migrate
npm run dev
```

Open <http://localhost:3000> and sign in with `OPERATOR_EMAIL` and
`OPERATOR_PASSWORD`. The database-backed health endpoint is
<http://localhost:3000/api/health> and returns HTTP 200 only when PostgreSQL is
reachable.

With the default `WORKFLOW_PROVIDER=local`, `npm run dev` starts one supervisor
that owns both the Next.js process and the local maintenance worker. The worker
waits for the health endpoint, requests an immediate maintenance cycle, and then
offers a new cycle every minute. `npm start` provides the same process lifecycle
for a production build. No foreground shell loop or host cron is required for
the aggregate inbound/follow-up/recovery cycle in this local workflow mode.

Local maintenance requires `OPERATOR_API_TOKEN` to contain at least 32
characters. The supervisor validates this once before starting either child and
exits with one actionable startup error when it is missing or too short; it does
not leave a worker logging an authentication failure every minute.

The example environment defaults all external providers to deterministic mock
mode. Replace the session and encryption placeholders before any non-local use.
OpenAI, Microsoft, and Trigger credentials are server-only and intentionally
blank. Never commit `.env` or `.env.local`.

Do **not** run a seed command for a real installation. Migrations create only
the schema and operational singleton rows; connect the real mailbox from
Settings. For the first controlled send, keep automatic follow-ups disabled and
review the mailbox and campaign daily caps explicitly before enabling sending.

## Optional local mock demonstration

To add the deterministic `operator@example.com` mock mailbox explicitly:

```bash
npm run db:seed:mock
```

`npm run db:seed` remains a compatibility alias for this demo-only command. It
must not be part of a real installation bootstrap. The database volume is
persistent: migrations and seed commands do not erase earlier campaigns,
messages, replies, or suppressions.

To preserve an existing development database as an archive, create a separate
database, migrate it, and only then change `DATABASE_URL`:

```bash
docker-compose exec -T postgres psql -U hyperoutreach -d postgres \
  -c "create database hyperoutreach_live owner hyperoutreach"
DATABASE_URL=postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach_live \
  npm run db:migrate
```

Do not run this create command again after the database exists, and do not run
the mock seed against it.

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
- `npm run db:seed:mock` idempotently creates the explicit local-demo mock
  mailbox; `db:seed` is only a compatibility alias.
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

Account creation and AI discovery share one conservative identity policy. An
exact normalized domain always reuses its account. A newly supplied domain may
enrich the single same-name domainless account; a domainless input may reuse a
single unambiguous same-name account. When several same-name accounts have
different domains, Hyperoutreach refuses the automatic merge and requires a
domain instead of choosing an arbitrary oldest row. Contact discovery reports
validated known identities through the same global LinkedIn/company-scoped
fallback constraints; rerunning it may consume another provider call but cannot
create a duplicate strong identity.

## Discovery, research, and email resolution

Narrow account-discovery, account-research, contact-discovery,
personalization, and reply-classification agents share a strict structured-output
boundary. `OPENAI_PROVIDER=openai` sends every AI task through OpenAI's Responses
API, current `web_search`, and Zod-derived strict JSON schemas.

`OPENAI_PROVIDER=codex` is an optional mode for a local, single-operator
installation. One locally installed Codex CLI provider uses the operator's
authenticated ChatGPT account for every AI task. Research requests enable live
web search with `--search`; personalization and reply classification keep web
search disabled. Codex mode does not construct an OpenAI API client and does not
require `OPENAI_API_KEY`. A Codex failure fails the current task and never
silently falls back to the API.

Before enabling the mode, install Codex locally and authenticate it with
`codex login`. A successful `codex login status` confirms authentication only;
it does not prove that the installed CLI supports Hyperoutreach's hardened
invocation. That invocation is tested with Codex CLI 0.147.0 and fails closed if
required flags or isolation settings are incompatible. Then configure the
server-only environment and restart the application:

```bash
OPENAI_PROVIDER=codex
WORKFLOW_PROVIDER=local
CODEX_EXECUTABLE=codex
CODEX_RESEARCH_MODEL=gpt-5.6-terra
CODEX_FAST_MODEL=gpt-5.6-luna
CODEX_TIMEOUT_MS=240000
CODEX_MAX_CONCURRENCY=1
```

For web requests, the hardened invocation keeps Codex's Code Mode host enabled
because Codex CLI 0.147.0 requires it to expose the GPT-5.6 web-search tool even
when `--search` is present. Shell, unified execution, browser, app, plugin,
memory, image, computer-use, and subagent capabilities remain disabled. Non-web
requests also disable the Code Mode host. The generated wire schema removes the
unsupported JSON Schema `format: "uri"` annotation and regex lookarounds that
Codex rejects, while the original Zod schema still validates every returned URL
and email after execution.

Codex mode requires local workflow execution and is rejected with
`WORKFLOW_PROVIDER=trigger`; a hosted Trigger worker cannot use the operator
machine's CLI installation or ChatGPT login.

Codex JSONL proves that a web search occurred and records its query, but Codex
CLI 0.147.0 does not expose the result URLs in the completed `web_search` event.
Its validated HTTP(S) citations are therefore persisted as
`model_declared_after_search`: the model declared them after an observed search,
but Hyperoutreach cannot prove that each URL appeared in the hidden result set.
Responses API sources are persisted separately as `tool_observed`, because they
come directly from `web_search_call.action.sources`. The UI and audit data do
not present these two provenance strengths as equivalent.

This mode is not a hosted multi-user authentication mechanism and must not be
used to expose one operator's Codex session to remote users. Hyperoutreach does
not extract ChatGPT tokens or invoke the ChatGPT desktop app; it launches the
authenticated Codex CLI as a constrained local subprocess. `/settings` reports
only a sanitized installed/authenticated status and never displays account
identity or secrets. Codex token usage is recorded when the CLI reports it, but
dollar cost remains unavailable because ChatGPT-plan consumption is not API
metering.

`OPENAI_PROVIDER=mock` keeps all AI tasks deterministic and credential-free.
OpenAI model names use `OPENAI_RESEARCH_MODEL` and `OPENAI_FAST_MODEL`; Codex
uses `CODEX_RESEARCH_MODEL` and `CODEX_FAST_MODEL`. Their defaults are
`gpt-5.6-terra` and `gpt-5.6-luna`. All live modes fail closed on missing or
invalid configuration and never silently fall back to another provider.

Credential-free development uses deterministic mock agents through the same
interfaces. Each persisted operation records agent/model/prompt/schema versions,
structured input/output, provider response/thread ID, sources, detailed
token/cache/reasoning usage, web-search call count, cost availability/value,
completion state, and sanitized failures in `agent_runs`. Provider sources carry
their provenance strength: Responses URLs are tool-observed, while Codex URLs
are model-declared after an observed search. Account research has a configurable
freshness TTL, a crash-recoverable
ownership claim that avoids duplicate concurrent calls, and one snapshot reused
by every contact. A global
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
`PublicEmailEvidenceProvider`; the selected live AI provider performs web search
and binds every structured sample to a validated HTTP(S) source with its provider
provenance marker. It ignores examples
from other domains, excludes samples ambiguous across multiple conventions,
deterministically infers supported address conventions, normalizes international
names, and performs replaceable real/mock MX checks. RFC null MX means the domain
does not accept mail; any MX only affects confidence and never proves that a
recipient exists. Below the confidence threshold, an optional
`EmailEnrichmentProvider` can add candidates;
no-result and transient-failure outcomes remain explicit instead of inventing an
address. DNS and conventional enrichment retain their short provider deadline.
AI public-evidence research has its own deadline: Codex uses
`CODEX_TIMEOUT_MS` (240 seconds by default) while Responses uses its provider
operation timeout. All remain abortable and deadline-bound. A claim fenced by
contact/account/domain/employment version keeps
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

Sending and inbound reconciliation still resolve the adapter from each
connected mailbox. The global `MAIL_PROVIDER=microsoft_graph` value additionally
enables the separate Graph notification-subscription maintenance task; without
that value the task intentionally skips, even if a Microsoft mailbox row exists.

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

The ordered maintenance cycle reconciles available Microsoft mailboxes through
the same inbound stage as SMTP/IMAP. Microsoft notification-subscription
maintenance remains a separate responsibility: Trigger.dev runs its dedicated
five-minute schedule. The authenticated
`POST /api/internal/microsoft/reconcile` endpoint remains available for an
explicit local diagnostic or recovery run. The webhook's post-response worker
is only a latency optimization; database-backed reconciliation remains the
correctness boundary.

This Graph subscription lifecycle is deliberately separate from the aggregate
send-safety cycle. A self-hosted local Microsoft installation that requires
continuous webhook renewal must run that narrow operation through its own
infrastructure automation or use Trigger.dev; SMTP/IMAP does not require it.

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

## SMTP/IMAP mailboxes

Mail delivery is selected per mailbox. In `/settings`, use **Connect an
SMTP/IMAP mailbox** for providers that expose standard protocols (Zimbra,
university/company webmail, Fastmail, and similar services). Enter the mailbox
address, provider username, IMAP and SMTP endpoints, and preferably an
app-specific password. The connection is saved only after IMAP authentication,
Drafts/Sent folder discovery, and SMTP authentication all succeed.

Only encrypted transports are accepted: implicit TLS or mandatory STARTTLS.
`TOKEN_ENCRYPTION_ACTIVE_KEY_ID` and `TOKEN_ENCRYPTION_KEYS` are required because
the password is stored as an AES-256-GCM envelope and is never rendered back to
the operator. Disconnect waits for any in-flight mailbox action, then clears the
password envelope, transport configuration, and inbound cursor.

The automatic local worker and Trigger.dev both reconcile every available
SMTP/IMAP inbox once per minute through the shared durable inbound path. **Sync
now** is an additional operator action, not a correctness requirement. Before
classification or body persistence, mail must match an outbound identity;
unrelated private mailbox traffic is ignored.
Standard delivery-status reports become hard/soft bounce signals. Verified hard
bounces stop the enrollment and suppress the recipient. Definite SMTP 5xx
recipient refusals are terminal failures, while ambiguous socket failures remain
quarantined to prevent duplicate sends.

For local verification, `npm run db:up` starts loopback-only GreenMail and
`npm run test:integration` executes the real TLS IMAP/SMTP round trip. The suite
never uses production mailbox credentials.

## Durable workflows

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
3. recover stale work.

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

Settings, and only Settings in this iteration, shows the persisted maintenance
projection:

- **Not started** — no cycle has ever been recorded;
- **Running** — a cycle owns the lease and its heartbeat is current;
- **Stalled** — an owner remains but its heartbeat is stale;
- **Failed** — the latest failure is newer than the latest success;
- **Overdue** — no cycle is active and the last success is outside the expected
  window;
- **Healthy** — no cycle is active and the last success is recent.

`Running` is distinct from `Overdue`: a normal long Codex cycle remains running
while its heartbeat is current. The no-owner overdue window is the greater of
`CODEX_TIMEOUT_MS + 60 seconds` and three maintenance intervals (five minutes
with the default 240-second Codex timeout). Settings also shows the automation
provider/mode, active-cycle timestamps when applicable, the last success, and a
sanitized historical failure without exposing the lease token or credentials.

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
  no commit at that time. The repository now has a `main` history and the
  maintenance design commits are ahead of `origin/main`; the current
  implementation remains uncommitted until its final gate. The previously
  released baseline passed a fresh filesystem export excluding dependencies,
  build output, local environment files, and test artifacts through `npm ci`,
  formatting, lint, typecheck, unit/integration tests, eval, migration-history
  validation, Trigger task import, and production build. The maintenance change
  set must rerun those gates before the same claim is made for it.
- Live OpenAI Responses, Microsoft Graph, and Trigger.dev Cloud behavior is not
  claimed as verified. Their adapters are contract-tested without network
  access; live checks still require explicitly supplied credentials and, for
  Graph notifications, a public HTTPS endpoint. Codex CLI 0.147.0 has been
  exercised through the exact application provider, including structured web
  research and the public-email resolution service with its 240-second lane.
  The Trigger.dev task module and dispatcher contract are tested locally, but
  cloud execution/deployment still needs a configured project. Mock mode keeps
  the entire application credential-free.
- The full credential-free critical lifecycle is verified through rendered
  Chromium as documented above. Live provider smoke checks remain separate.
- A full development-dependency `npm audit` retains five moderate findings in
  legacy `esbuild` versions pulled by the pinned current Trigger.dev and Drizzle
  CLIs; npm reports no compatible fix for those chains. They are not shipped in
  the production dependency tree (`npm audit --omit=dev` reports zero findings).
  A lockfile override to `tar` 7.5.22 removes the high/critical archive findings
  that those development tools otherwise inherited.
