# Hyperoutreach MVP Implementation Plan

> Status: in progress. `SPEC.md` is authoritative. Checkboxes reflect verified repository state, not intent.

## Goal

Ship a self-hostable, single-operator prospecting and customer-discovery application that turns an ICP into evidence-backed prospects, approved outreach, durable follow-ups, and reply-driven suppression while PostgreSQL remains the source of truth.

## Architecture decisions

- Modular TypeScript monolith with Next.js App Router, PostgreSQL, Drizzle ORM, Trigger.dev, OpenAI Responses API, and Microsoft Graph.
- Server-rendered UI plus route handlers/server actions; no separate backend or client-side secret access.
- PostgreSQL owns lifecycle state, immutable campaign versions, idempotency records, suppression, workflow events, and audit data. Trigger.dev only executes durable work.
- Narrow adapters isolate OpenAI, Microsoft Graph, enrichment, DNS, and workflow dispatch. Local deterministic adapters exercise the same application services without credentials.
- Deterministic policies own sending, enrollment, state transitions, deduplication, suppression, pacing, and follow-up eligibility. AI only returns schema-validated research, personalization, or classifications.
- Microsoft sending uses persisted message rows, Graph drafts, `X-Outreach-ID`, immutable Graph IDs, and reconciliation after uncertain outcomes.
- The deployment model is one operator per installation. An environment-configured operator login and signed, secure server-side session protect all UI/actions; only health, OAuth callback, and Graph webhook endpoints are public, with their own state/signature/client-state validation. Multi-tenancy and bulk-mail infrastructure are intentionally outside this MVP.

## Milestones and acceptance criteria

### 1. Foundation and relational integrity

- [x] Reproducible npm setup, documented environment, Docker PostgreSQL, Drizzle schema, repository-visible SQL migration history, seed path, and health endpoint.
- [x] Constraints prevent duplicate account domains/names, identifiable contacts, campaign enrollment, sequence-step messages, inbound messages, and suppression entries.
- [x] Unit/integration harnesses run locally with deterministic fixtures.

### 2. Reliable outreach vertical slice

- [x] UI creates an account/contact, campaign, immutable campaign version and steps, then enrolls the contact once.
- [x] Deterministic interpolation persists the exact proposed subject/body; review supports approve, edit, and reject.
- [x] Approval executes the shared send service through a mock mailbox, persists draft/provider IDs and state transitions, and remains safe under duplicate execution.
- [x] Publishing/editing creates immutable campaign versions; active enrollments remain pinned to their original templates and delays.
- [x] A due follow-up rechecks policy; terminal replies stop it; out-of-office, automated, and unknown classifications follow their explicit non-terminal/manual-review rules.
- [x] Reply classification and confidence are persisted. Unsubscribe and hard bounce create global suppression and block later sends; soft bounce follows a bounded retry/review policy.

### 3. Discovery, research, and email resolution

- [x] Real OpenAI Responses adapter uses web search and strict structured outputs; deterministic mock mode needs no credentials.
- [x] Account discovery normalizes/deduplicates companies; source-bound account research is concurrency-claimed, crash-recoverable, and stored once with evidence, freshness, confidence, and complete agent-run metadata.
- [x] Contact discovery persists provider-source-backed roles, globally deduplicates contacts, and records validated employer moves without attaching ambiguous employment evidence.
- [x] Email resolution verifies an evidenced domain, infers public patterns, generates candidates, checks DNS/MX, scores confidence, supports an optional enrichment adapter, and persists typed resolution outcomes.
- [x] Employer moves invalidate old email candidates and prior active enrollments atomically; personalization is restricted to caller-supplied trusted research URLs.
- [x] Employment-version/message binding and shared contact action locks close the move/send race; owner-fenced resolution claims reject late former-domain results.
- [x] Fact-level supports, server-observed evidence refresh, provenance-bearing public-email search, ambiguity-safe scoring, null MX, one-accepted-address integrity, and bounded provider calls are enforced and tested.
- [x] Contact batches and successful run completion commit atomically within requested limits; account domain/domainless merging is deterministic across order and concurrency.

### 4. Durable workflows and Microsoft 365

- [x] Trigger.dev tasks cover discovery, research, resolution, generation, send/advance, webhook processing, and delta reconciliation with explicit global idempotency where required.
- [x] Durable waits/schedules persist `next_action_at` and workflow run metadata, recheck current database state on wake, handle retries/cancellation/stale invocations, and recover from executor downtime without Trigger.dev becoming the business-state authority.
- [x] Microsoft OAuth authorization/callback/token refresh is server-only and encrypted at rest; scopes are documented and minimal for draft/read behavior.
- [x] Graph adapter creates a draft with an outreach ID, persists immutable ID before send, confirms/reconciles Sent Items, ingests webhooks, and stores/advances delta links.
- [x] Every scheduled send checks campaign/enrollment/mailbox state, reply/bounce/manual stop, recipient/domain suppression, working hours, minimum delay, daily mailbox/campaign caps, emergency pause, recent/cross-campaign contact history, professional relevance, and existing step message inside the database transaction boundary.
- [x] Graph notification payloads and client state are validated; subscriptions renew; inbound ingestion is idempotent; delta links persist; expired/invalid delta state can safely rebaseline and recover missed webhooks.

### 5. Operable UI and observability

- [x] Functional pages exist for prospects, prospect detail, campaigns, review queue, inbox/replies, and settings/integrations.
- [x] UI controls operate discovery/research/resolution and reruns, campaign configuration/version publication, review/edit/reject, connect/disconnect, sending limits/emergency pause, suppression management, sync/reconciliation, and failure inspection.
- [x] Evidence, confidence, generated content, message history, state/stop reason, workflow failures, retries, and agent metadata are inspectable.
- [x] Every AI operation records agent/model/prompt-schema version, structured input/output, sources, usage/cost when available, and sanitized errors; workflow attempts and state transitions are reconstructable from PostgreSQL.
- [x] Sensitive values are never rendered or logged; errors shown to users are sanitized.

### 6. Verification and final engineering review

- [x] Formatting, lint, typecheck, unit tests, database integration tests, workflow/adapter contract tests, request-context Playwright critical-flow tests, migration validation, and production build pass.
- [ ] The rendered Chromium UI operates the entire critical lifecycle on a supported browser host; the opt-in page-driven test now encodes the full create/dedupe/research/evidence/resolve/campaign/enroll/review/send/follow-up/reply/stop/suppress/blocked-send lifecycle, but Chromium launch is denied by this managed host before the test can execute.
- [x] Production HTTP request-context workflow verifies create → dedupe → research → resolve → generate → approve → mock send → follow-up → reply → stop → suppress, including exact cross-campaign suppression; rendered-browser coverage is tracked separately above.
- [x] Automated tests explicitly cover duplicate workflow execution/enrollment, uncertain send outcome, immediate pre-follow-up reply, unsubscribe, hard/soft bounce, campaign pause, manual/emergency stop, suppression, stale invocation, missing/low-confidence enrichment, transient provider failure, webhook loss recovered by delta, and executor recovery.
- [x] A versioned deterministic synthetic evaluation fixture and command report account/contact precision, fact-level evidence support, email accuracy/confidence/reasons, personalization acceptance, reply outcomes, policy blocks, and duplicates prevented; captured-output mutations and declared regressions fail the command without live providers.
- [ ] A separate roughly 100-prospect real, manually verified calibration fixture measures captured model/prompt outputs; the included 100-prospect fixture explicitly proves offline evaluator behavior only and is not empirical evidence.
- [x] Separate final review checked concurrency, idempotency, security, indexes, provider boundaries, stale state, N+1 access, dead code, documentation, and required-feature gaps; material code/eval/test findings were fixed, while the independently tracked repository-snapshot, empirical-eval, and rendered-browser verification gaps remain open.
- [ ] A clean-checkout README and `.env.example` document install/bootstrap, Docker/legacy Compose, migrations, mock/live modes, Trigger.dev setup, Microsoft app registration and webhook exposure, encryption/session keys, live smoke checks, deviations, and limitations; installation from an immutable Git snapshot remains unverified because no `HEAD` exists and `.git` is read-only here.

## Validation commands

```bash
npm ci
npm run db:up
npm run db:migrate
npm run db:check
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run test:e2e
npm run eval
npm run build
```

## Current reliability remediation

- [x] Serialize final sends through a non-queuing global advisory lock, bound provider operations with abortable timeouts, and prove pool/lock cleanup under contention and failure.
- [x] Persist and hold inbound replies before classification; reconcile failed/pending ingestion without allowing a due follow-up to pass the hold.
- [x] Make follow-up proposal/send claims crash-recoverable and transient policy blocks resumable with bounded due reconciliation.
- [x] Harden reply identity validation, multi-identifier matching, rematch audit history, suppression provenance/removal, terminal guards, and campaign pause/resume.
- [x] Reuse persisted unmatched/ambiguous reply classifications during reconciliation and rematch without new classifier calls or agent-run rows.
- [x] Replace unbounded history loads, retain the existing matching indexes, and rerun clean/populated migration plus full static/test/build gates.

## Known deviations and live-verification boundary

- No worktree is used for initial scaffolding because the repository has no commit from which to create one. The managed workspace also makes `.git` read-only: the complete tree is present, but an initial Git commit/archive and install from that immutable clean-checkout snapshot cannot be created or verified in this environment.
- Local mock OpenAI and mail adapters are the automated acceptance surface. The real OpenAI adapter is contract-tested; live OpenAI/Graph verification is only claimed when usable credentials are present and a safe smoke test is actually run.
- The repository-visible offline eval is a deterministic synthetic regression gate, not an empirical quality study. It does not replace the later calibration set of roughly 100 real, manually verified prospects described in `SPEC.md`, nor does it claim live model/prompt quality without captured provider outputs and human labels.
