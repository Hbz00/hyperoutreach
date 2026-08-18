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
unit/integration/Playwright coverage are included. The ChatGPT desktop adapter
has been exercised against the real app. Microsoft Graph and Trigger.dev
adapters are implemented and contract-tested; their live verification still
requires the operator's own credentials.

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
Microsoft and Trigger credentials are server-only and intentionally blank; the
AI path takes no credential at all, because it drives the operator's own signed-in
ChatGPT app. Never commit `.env` or `.env.local`.

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
The application bounds failed login attempts per forwarded client address and
across all addresses. Those windows exist to damp noise and to keep a wrong
password cheap; they are deliberately not what stops a determined guessing
attack, and the trusted reverse-proxy rate limit is not optional advice for
distributed or multi-process deployments — it is the bound.

The reason is worth stating rather than leaving to be discovered. The forwarded
address is written by the client, so an attacker rotates it and never meets
their own window. Only the shared window is left, and a shared window that
refuses everyone locks the single operator out of their own installation after
a minute of anonymous requests from anywhere. So the credentials are evaluated
before the windows decide, and a correct password is always admitted. The cost
is that a wrong password answers 429 and a right one answers 303, which tells
an attacker whether a guess was right. That is unavoidable here: "a correct
password always works" and "an attacker cannot test passwords" are the same
statement negated, and with one shared secret and no out-of-band recovery the
availability of the account is the property worth keeping.

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
boundary. Every one of them runs on the operator's own ChatGPT desktop app: the
app is driven through its devtools protocol, the turn is typed into the real
composer and the answer is read back from the surface. No API key is involved,
and no network request is reconstructed — the app performs its own request
exactly as it would for a human.

The two lanes differ only in how the picker is set. Research agents run
`AI_RESEARCH_MODEL` at `AI_RESEARCH_EFFORT` (default `GPT-5.6 Sol` at `High`)
and may use the app's web search; personalization and reply classification run
`AI_FAST_MODEL` at `AI_FAST_EFFORT` (default `GPT-5.6 Sol` at `Instant`). Effort
and model are always stated: an unset value would inherit whatever default the
app carries, which is how evidence-bound research silently degrades.

```bash
AI_PROVIDER=chatgpt_desktop
WORKFLOW_PROVIDER=local
AI_RESEARCH_MODEL=GPT-5.6 Sol
AI_RESEARCH_EFFORT=High
AI_RESEARCH_TIMEOUT_MS=600000
AI_FAST_MODEL=GPT-5.6 Sol
AI_FAST_EFFORT=Instant
AI_FAST_TIMEOUT_MS=120000
```

The public-address search names its source families explicitly — the company's
own material, documents written by third parties (programme PDFs, press kits,
tender documents, legal notices, job adverts), and contact or people-search
databases — because companies that publish no address on their own site still
appear in files written by others. It refuses two things by name rather than by
principle: reporting a person whose address the cited page does not actually
show, and reporting an address a page displays masked or truncated. Both are
behaviours a model can check itself against; a general "do not infer" clause
alone did not stop either.

Each turn opens a new chat, switches the app into temporary chat so nothing is
persisted in the account history, selects model and effort, sends the prompt,
waits for the answer to stabilise, and restores the mode it found. Turns are
serialized because the app has a single composer, and each turn carries its own
deadline, counted from the moment the caller asked — including the wait for the
composer to be free. That bound has a visible consequence: while a long
research turn holds the window, a short call queued behind it can exhaust its
own deadline without ever being sent, and fails rather than piling up. The
queue lives in the application process; running `npm run chatgpt` at the same
time drives the same window from outside it.

The app cannot be handed an output schema, so the schema travels in the prompt
and is enforced after the fact by the same Zod schema the rest of the pipeline
uses. An answer that is not a single valid JSON object earns exactly one
correction turn; a second failure fails the task rather than persisting
something unvalidated. Answers are read from the document tree, not the
rendering, so a linkified URL cannot break a JSON string.

Two limits follow from the surface and are treated as facts, not gaps: the app
reports neither token usage nor its searches, so cost is `unavailable` and tool
usage is null rather than an invented zero; and every citation is persisted as
`model_declared_after_search`, because nothing in the surface proves a URL came
from a result set.

`AI_PROVIDER=chatgpt_desktop` requires local workflow execution and is rejected
with `WORKFLOW_PROVIDER=trigger`: a hosted worker has no desktop app to drive.
This is a single-operator arrangement and must not be used to expose one
operator's ChatGPT session to remote users. `/settings` shows the lane models
and efforts, never account identity or secrets.

`AI_PROVIDER=mock` is the default and keeps all AI tasks deterministic and
credential-free. The live mode is opt-in by name because it has side effects on
the operator's own machine: it launches and drives their ChatGPT app.
Configuration failures are explicit: no mode silently falls back to another.

The retired Codex CLI provider is still in the tree under `src/lib/codex/`,
unplugged from the provider factory. It is kept for reference, not selected by
any configuration.

Credential-free development uses deterministic mock agents through the same
interfaces. Each persisted operation records agent/model/prompt/schema versions,
structured input/output, provider response/thread ID, sources, detailed
token/cache/reasoning usage, web-search call count, cost availability/value,
completion state, and sanitized failures in `agent_runs`. Provider sources carry
their provenance strength: desktop-app URLs are model-declared after the
model's own search. Account research has a configurable
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
recipient exists. This installation integrates **no** third-party enrichment
service: `composeEmailResolutionProviders` supplies `null`, and the
`EmailEnrichmentProvider` seam stays available for one that is actually
configured. Standing a no-result stub in that slot instead made every unresolved
contact report `enrichment_no_result` — a diagnosis about a service that was
never asked — and hid the two reasons that matter,
`insufficient_public_evidence` and `low_confidence`. No-result and
transient-failure outcomes remain explicit instead of inventing an address.

**A company is searched once.** The question the model is asked is the company's
convention, not one person's address, so a successful search is reused for every
other contact at that account for thirty days
(`DEFAULT_PUBLIC_EVIDENCE_TTL_MS`). Reuse is read from the audit trail, which
already records each search with its domain, result and completion time, so
there is no second store to disagree with the record. Three things are never
reused: a search that found nothing — the same prompt on the same domain has
returned zero, one and two addresses on consecutive attempts, so caching the
worst draw would retire a company a second look resolves — a record older than
the lifetime, and a record made by an earlier prompt version, which is what
makes improving the prompt reach companies already searched. **Force a fresh
company search** on the contact page overrides all of it and spends a live web
search. Each candidate records which search it rests on and whether that search
was fresh or reused, shown beside its address convention.

**Resolving addresses is an action on a company.** `/prospects` offers it on each
company row with the number of contacts it would act on, and the contact page
offers the same button; the per-contact action survives beside it for the
exception — somebody who just changed employer, a manual addition — rather than
being the normal path. One click queues one resolution per contact, and only the
first carries a forced re-search, so a ten-person company can never spend ten live
searches. Two contacts are never included: one already resolved (unless the search
is forced), and one whose accepted address has already been written to, because
moving the address of somebody who may be holding a message would make that
message unsendable and could end with two addresses used for one human.

DNS and conventional enrichment retain their short provider deadline.
AI public-evidence research has its own deadline, `AI_RESEARCH_TIMEOUT_MS`
(600 seconds by default), because it is web research like any other research
call. All remain abortable and deadline-bound. A claim fenced by
contact/account/domain/employment version keeps
late old-employer results from persisting. PostgreSQL permits at most one accepted
address per contact, and later resolutions replace it transactionally. Contacts
durably retain a typed outcome reason (including missing domain,
insufficient evidence, missing MX, provider failure, an exhausted ladder, a ladder
bound, or every remaining address being suppressed) for UI and operational
inspection. SMTP recipient probing is not used.

## The address ladder

A contact holds an **ordered ladder** of the addresses the evidence named for
them, not a single verdict. Rung one is the best-evidenced convention; later rungs
are the others, ordered by evidence and then by how common the form is — never
alphabetically, which is what the previous tiebreak amounted to. A contact whose
company showed one convention has a one-rung ladder, and that is a complete state,
not a degraded one.

Two conventions evidenced exactly as well as each other used to be refused
outright, because picking one was a coin toss whose losing side was a bounce, a
permanent suppression and a prospect spent for nothing. Under a ladder the loser
of a tie is simply rung two, so the pair resolves — and the review card says the
order was arbitrary, because approving the message is now the only human check on
it.

**A proven-dead address advances the ladder instead of ending the person.** A hard
bounce — an explicit delivery-status report, or a definite SMTP recipient refusal
— establishes two separate facts, and the product used to conflate them: the
address is dead, the person is not. The suppression written for the dead address
stays permanent and keyed on the address alone; what changes is that the next
evidenced address is accepted, the enrollment returns to the step that bounced
without consuming it, and the re-addressed message is queued for review. It is
**offered, never automatic**: a re-addressed first message is still a first
message, and no first send in this product may be system-originated. Follow-up
timing counts from the most recent attempt that was not proven dead — never from
"the one that landed", which is a fact this product cannot establish.

Only a hard failure advances anything. Soft failures, greylisting and quota
refusals stay on the existing retry path. A report naming a different recipient
than the one addressed advances nothing. Silence is never a signal in either
direction: it is not read as delivery and not read as failure.

Five rules bound what may advance:

- Every _attempted_ message on the enrollment must be proven dead. One that was
  attempted and is not — including one whose delivery is merely uncertain — blocks
  the advance permanently, because the prospect may be holding it. This makes the
  ladder almost entirely a step-zero feature, which is the right shape: a hard
  bounce at step two on an address that carried step zero says the person left,
  not that the convention was wrong.
- A sequence somebody _ended_ is never resurrected. The one terminal state that
  may advance is a sequence that completed by running out of steps, which is where
  a one-step campaign lives.
- The contact's employment must not have changed since the dead message.
- A suppressed address is never offered as a rung, and says so. A suppression is
  permanent and keyed on the address alone, so a colleague's failed guess can own
  the address this person's convention produces; un-blocking it is the existing
  suppression-removal flow, which already demands a justification and an explicit
  override for a hard-bounce entry.
- The bounds in `/settings`: how many addresses one contact may cost (three by
  default, counted as addresses attempted), how many advances one company may
  produce in a day (two), and a circuit breaker on the share of attempted sends
  producing an explicit delivery failure (30% over thirty days, ignored below
  twenty attempted sends — one failure out of one send is 100% and means nothing).
  Each is shown beside the number it is judged against. There is deliberately no
  separate per-mailbox advance ceiling: an advance originates no send, and the
  sends the operator then approves are already bounded by the per-mailbox daily cap
  and pacing delay.

An exhausted ladder reaches the same terminal state a bounce reaches today. The
distinct outcome the operator asked for lives where it belongs — on the contact's
address, as `ladder_exhausted` — rather than on the sequence, which honestly
bounced.

**A bound is a pause, not a verdict.** Only facts no setting changes end the
prospect: nothing left to try, every remaining address suppressed, an earlier
message that was never reported undelivered, an employer that moved, a sequence
somebody ended, or the feature switched off. When a _raisable_ bound stops an
advance — the rung ceiling, the per-company daily cap, an open circuit breaker —
the enrollment is parked in manual review at the step that bounced, with no
schedule, and the contact reads `ladder_limit_reached`. Raising the bound and
resolving the company again promotes the address that is still there, because a
dead one is never re-accepted and the next rung is simply the best that is left.
Ending the prospect instead would have made the per-company cap — a pacing device
— lose the third bounce of the day at one company as permanently as an exhausted
ladder, with nothing able to bring them back.

The one refusal that is not a bound has its own sentence:
`ladder_earlier_send_unconfirmed`, for a person who may be holding a message
already. Nothing the operator changes alters that answer, so it must not read as
an invitation to try.

**Delivery outcomes demote a convention and can never confirm one.** A convention
proven dead for at least two distinct people at one company, and for at least half
the people it was attempted on there, is ordered last for that company's contacts.
The share is not decoration: a hard bounce cannot tell a wrong address shape from a
person who has left, so at a company whose contact data is stale a _correct_
convention fails a few times out of many — and a rule counting failures alone would
demote true conventions hardest exactly where discovery is weakest. Demotion
reorders and never rescores: public-sample confidence and the delivery record stay
two visible quantities, side by side on the contact page and on `/outbound`, because
merging them is where a retroactive rescoring of addresses already sent would get
made silently. It also never removes — a contact whose only rung uses the demoted
convention keeps it — and it re-ranks only contacts with no outbound message at
all, so an address a generated message is already pinned to is never moved under
it.

A ladder belongs to **one company**. A contact who changes employer keeps the
addresses evidenced at the old one, so their rows can span two domains — and both
the ordering and the choice of the next rung are scoped to the domain the dead
message was sent at, so one employer's verdict never reorders another's addresses
and a former employer's address is never offered as the next thing to try.

The verdict is **written down when it is reached, not recomputed on every read**.
A live ratio falls: two deaths in four attempts demotes a convention, and four
later attempts that reported nothing would put it back under the threshold and
restore it — silence confirming a convention, which delivery evidence here is
never allowed to do. The demotion is latched per mail domain and convention, with
the counts that produced it, and the latch can only add.

`/outbound` reports the yield beside the cost: how many prospects are alive on rung
one, how many were reached on a later rung, how many have no further address to
try, how many were stopped by a bound, and — per convention — how many people were
attempted, how many were proven dead, and at which companies each convention is
demoted.

Every send falls in exactly one of three buckets: **proven not to exist**,
**something came back that was not a failure**, or **nothing came back**. The
middle one — a reply, an out-of-office, an autoresponder — is the only positive
delivery evidence this product ever receives, and it is kept out of the last one.
Counted as "attempts minus explicit failures", that last bucket was the arithmetic
complement of the failure rate and tested nothing, where the point of it is to
test whether the domains being written to report bad addresses back at all. A
temporary failure sits there too: it says the address may be wrong, never that it
is. The per-convention table counts _people no failure was reported for_, which is
a weaker statement and is labelled as one — answering it per convention would mean
joining every candidate to its replies for a number the question does not need.

The review queue lists every prospect **parked with nothing to move them**: an
enrollment waiting on a decision with no message written, nothing queued to write
one, and no unclassified reply being reprocessed on its own. A raisable bound puts
prospects there deliberately, and any other silent failure to queue work lands
there too. They are never resumed automatically — an advance is a send, and no
first send in this product is system-originated — so the list links to the
prospect, where resolving the company again promotes whichever address is still
standing.

Accepting an address **by hand** overrides confidence, MX and evidence, and
deliberately does not override delivery: an address a bounce has already proven
does not exist, or one the suppression list blocks, is refused with a sentence
naming what stands in the way. The lift is the existing suppression-removal flow.

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

## ChatGPT desktop bridge

`src/lib/chatgpt-desktop` drives the ChatGPT macOS app's Chat surface from
Node, so a prompt can be answered by the ChatGPT subscription rather than a
billed API key. It is macOS-only, and with `AI_PROVIDER=chatgpt_desktop` it is
the surface every agent runs on — `src/lib/ai/production-provider-bundle`
builds both lanes on top of it. The commands below drive the same bridge by
hand, which is how a broken selector is diagnosed.

```bash
npm run chatgpt -- --models
npm run chatgpt -- --model "GPT-5.6 Sol" --effort High "your prompt"
echo "your prompt" | npm run chatgpt -- --json
npm run chatgpt:doctor
```

```ts
import { askChatGptDesktop } from "@/lib/chatgpt-desktop";

const { text } = await askChatGptDesktop({
  prompt: "…",
  model: "GPT-5.6 Sol",
  effort: "High",
});
```

Each call opens a new chat, switches Temporary chat on so the turn leaves no
history, selects the model, sends the prompt, waits for the answer to settle,
and restores the mode it found. Calls are serialised, because the Chat surface
is a single shared window.

### How it works, and what it does not do

The app is Electron, and it already accepts Chromium's devtools switch. The
bridge attaches to that port and drives the app's own surface with devtools
input events, which reach the renderer without the window being focused or
visible, so it runs quietly in the background.

Everything network-facing stays inside the app: the request, its authentication
and its integrity checks are performed by ChatGPT itself, exactly as when you
press send. The bridge never reconstructs that traffic. Two paths were explored
and rejected on purpose:

- Calling `chatgpt.com/backend-api/f/conversation` from the app's bundled
  webview returns `403 Unusual activity` without the sentinel proof-of-work
  tokens. Reproducing them would mean defeating an anti-abuse measure, so the
  bridge does not.
- The app shell renderer cannot reach the backend at all — its `app://` scheme
  is not CORS-enabled, and its traffic goes through the main process over
  private IPC.

### Requirements and failure modes

The app must be running with its devtools port open. The bridge launches it
hidden and unfocused when it is closed:

```bash
open -g -j -a /Applications/ChatGPT.app --args --remote-debugging-port=9333
```

macOS ignores `--args` for an app that is already running, so an app started
without the switch cannot be attached to; the bridge reports that rather than
guessing. Override the port with `--port` or `CHATGPT_DESKTOP_CDP_PORT`.

Because the bridge drives a real interface, a ChatGPT desktop update can rename
a hook. Every one of them lives in `SELECTORS` in `chat-surface.ts`, and
`npm run chatgpt:doctor` checks them in order and names the first that no longer
holds.

Two failures are deliberately loud rather than silent, because degrading
quietly would break a guarantee the caller asked for:

- If the temporary-chat control cannot be found, the turn is refused instead of
  sent. Sending anyway would persist a prompt the caller asked to keep
  ephemeral.
- If the answer does not finish within the timeout, the call throws instead of
  returning what had arrived, which would pass a truncated answer off as a
  complete one. The partial text is carried in the error's `detail`.

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

Two probes sit beside that suite and are deliberately **not** part of it,
because each spends live turns on the operator's own ChatGPT window and must be
run deliberately, with the maintenance worker stopped:

```bash
npm run probe:personalization -- --runs 10
npm run probe:public-email -- --domain acme.example,globex.example
```

The first measures whether the fast lane holds the personalization contract. The
second compares the shipped public-address prompt against a candidate over the
same domains, scoring both with the production pattern inference so a win means
a contact would actually resolve. It reads the live database read-only, writes
nothing, and refuses to start while a maintenance lease is alive. Its verifier
is an ordinary HTTP client, so it can confirm an address on a readable page and
can never confirm one on LinkedIn or a contact database — those answer 999 and
403 to anything but the app itself. Read its `unverified` column, which means a
readable page that did not contain the address, as the only evidence of a
fabrication; `unreadable` means out of reach, not discredited.

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
- Live Microsoft Graph and Trigger.dev Cloud behavior is not claimed as
  verified. Their adapters are contract-tested without network access; live
  checks still require explicitly supplied credentials and, for Graph
  notifications, a public HTTPS endpoint. The ChatGPT desktop adapter has been
  driven against the real app, which must be installed, signed in and reachable
  on its debug port.
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
