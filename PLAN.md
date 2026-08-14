# Hyperoutreach MVP Implementation Plan

> Status: core MVP complete; automatic-maintenance remediation tasks 1–7 are implemented, while the final live smoke and completion review remain open. `SPEC.md` is authoritative. Checkboxes reflect verified repository state, not intent.

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
- [x] Manual account creation and AI discovery share ambiguity-safe domain/name merging; multiple same-name strong accounts require an explicit domain instead of arbitrary reuse.
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
- [x] The dashboard presents the six-step operator path and persisted readiness counts for mailbox sync, AI provider/model, accounts, email action, review, follow-ups, replies, and suppressions.
- [x] UI controls operate discovery/research/resolution and reruns, campaign configuration/version publication, review/edit/reject, connect/disconnect, sending limits/emergency pause, suppression management, sync/reconciliation, and failure inspection.
- [x] Evidence, confidence, generated content, message history, state/stop reason, workflow failures, retries, and agent metadata are inspectable.
- [x] Every AI operation records agent/model/prompt-schema version, structured input/output, sources, usage/cost when available, and sanitized errors; workflow attempts and state transitions are reconstructable from PostgreSQL.
- [x] Sensitive values are never rendered or logged; errors shown to users are sanitized.

### 6. Verification and final engineering review

- [x] Formatting, lint, typecheck, unit tests, database integration tests, workflow/adapter contract tests, request-context Playwright critical-flow tests, migration validation, and production build pass.
- [x] The rendered Chromium UI operates the entire critical lifecycle on a supported browser host. The post-fix run completed login → create/dedupe → research/evidence → resolve → campaign/enroll → review/send → follow-up → unsubscribe/stop/suppress → later blocked send in 8.3 seconds.
- [x] Production HTTP request-context workflow verifies create → dedupe → research → resolve → generate → approve → mock send → follow-up → reply → stop → suppress, including exact cross-campaign suppression; rendered-browser coverage is tracked separately above.
- [x] Automated tests explicitly cover duplicate workflow execution/enrollment, uncertain send outcome, immediate pre-follow-up reply, unsubscribe, hard/soft bounce, campaign pause, manual/emergency stop, suppression, stale invocation, missing/low-confidence enrichment, transient provider failure, webhook loss recovered by delta, and executor recovery.
- [x] A versioned deterministic synthetic evaluation fixture and command report account/contact precision, fact-level evidence support, email accuracy/confidence/reasons, personalization acceptance, reply outcomes, policy blocks, and duplicates prevented; captured-output mutations and declared regressions fail the command without live providers.
- [x] The evaluator accepts versioned captured model/prompt outputs and independent human labels for a roughly 100-prospect calibration. The repository fixture exercises that contract deterministically; running a live empirical comparison remains an explicitly documented credential/data-dependent validation step.
- [x] Separate final review checked concurrency, idempotency, security, indexes, provider boundaries, stale state, N+1 access, dead code, documentation, and required-feature gaps; all material code, eval, browser-test, and documentation findings were fixed. Live-provider and empirical model-quality checks remain explicitly documented external validation boundaries.
- [x] A clean-checkout README and `.env.example` document install/bootstrap, Docker/legacy Compose, migrations, mock/live modes, Trigger.dev setup, Microsoft app registration and webhook exposure, encryption/session keys, live smoke checks, deviations, and limitations. The prior MVP correction set was committed after its completion gate; the new automatic-maintenance gate is tracked separately below.

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
- [x] In self-hosted local mode, start maintenance with `npm run dev`/`npm start`; order each cycle as all available non-mock inbound mailbox reconciliation, due follow-ups, then stale-work recovery; abort later stages when inbox reconciliation fails.
- [x] Give AI public-email research a provider-specific deadline, and mark provenance-validated discovered employment as professionally relevant for deterministic send policy.

## Automatic maintenance worker remediation

- [x] Add the populated-safe singleton maintenance projection, workflow-history index, six-state resolver, and Codex-aware overdue window.
- [x] Add the owner-fenced aggregate cycle with heartbeat renewal, stale takeover, neutral busy outcomes, strict inbound → due follow-up → recovery order, and fail-closed inbound behavior.
- [x] Add the local worker preflight, health wait, immediate/minute ticks, long-cycle overlap guard, bounded request, sanitized logging, and graceful drain.
- [x] Make `npm run dev` and `npm start` supervise Next.js plus the worker in local mode; retain `dev:web`, `start:web`, and `maintenance:local` as narrow commands.
- [x] Replace the independently scheduled Trigger inbound/follow-up/recovery tasks with one minute aggregate schedule while leaving the narrow tasks callable; retain the separate Graph-subscription schedule.
- [x] Render the persisted six-state maintenance status only in Settings, without exposing owner tokens or raw provider errors.
- [x] Document automatic startup, opt-out and port rules, one-shot diagnostics, Trigger parity, and migration-without-seed installation.
- [x] Run the complete disposable gate, migrate and smoke `hyperoutreach_live` under emergency pause, verify automatic SMTP/IMAP maintenance without a send, perform the independent final review, and rerun all affected checks.

The automatic maintenance implementation is live-verified against the dedicated
`hyperoutreach_live` database and its available SMTP/IMAP mailbox: an automatic
cycle completed without a send, a same-minute duplicate tick was neutral, and
the database remained at zero messages/replies/due enrollments. The exact final
tree passed the disposable gate (551 unit and 256 PostgreSQL integration tests),
the synthetic eval, production build, production dependency audit, and 4 request
E2E workflows; the rendered Chromium workflow remains an operator-terminal
verification because the managed tool sandbox cannot reap or launch browser
processes reliably. The implementation is not yet claimed committed: the final
working-tree versions must be staged from a normal terminal before committing.
No live send, Microsoft Graph cloud run, or Trigger.dev Cloud deployment is
implied by this maintenance verification.

## Known deviations and live-verification boundary

- Initial scaffolding could not use a worktree because no commit existed at that time. The repository now has a `main` history; the approved maintenance design is committed ahead of `origin/main`, while this final verified implementation remains uncommitted pending operator staging from a normal terminal.
- Local mock OpenAI and mail adapters are the automated acceptance surface. The real OpenAI adapter is contract-tested; live OpenAI/Graph verification is only claimed when usable credentials are present and a safe smoke test is actually run.
- The repository-visible offline eval is a deterministic synthetic regression gate, not an empirical quality claim. Its versioned 100-case schema supports later captured provider outputs and human labels; a live Sol/Terra or prompt comparison still requires operator-supplied credentials and independently verified real-prospect data.
- Codex CLI 0.147.0 was smoke-tested live on 2026-08-14 through the exact application provider: Terra account discovery/research/contact discovery/public-email research, Luna personalization, and a like-for-like Sol discovery request all completed with observed web-search events where required. This proves provider compatibility, not comparative model quality; a representative human-labeled Sol/Terra benchmark remains open.
- The post-remediation Sol public-email service smoke completed in 23.3 seconds with a succeeded audited agent run and persisted source, proving the Codex-specific deadline and auxiliary web-event parser against the real backend. The Codex deadline is 240 seconds by default. `hyperoutreach_live` was created separately, migrated without seed, verified empty, and uses the established mailbox/campaign daily caps of 25/100; the prior `hyperoutreach` database remains unchanged as the development archive.
