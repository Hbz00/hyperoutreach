# Codex CLI Web Research Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex mode fully local for web and non-web AI work while recording the weaker, model-declared source provenance honestly.

**Architecture:** Keep one structured-provider contract and one Codex process boundary. Web requests add `--search`, use a generic output-and-citations envelope, and parse completed JSONL search events; provider bundle routing selects exactly one live provider with no fallback.

**Tech Stack:** TypeScript, Zod, Vitest, Codex CLI JSONL, Next.js 16.

---

## Chunk 1: Provider and configuration

### Task 1: Make Codex a complete provider

**Files:**

- Modify: `src/lib/openai/provider-config.ts`
- Modify: `src/lib/openai/provider-bundle.ts`
- Modify: `src/lib/openai/production-provider-bundle.ts`
- Create: `src/modules/workflows/provider-config.ts`
- Modify: `src/modules/workflows/dispatcher-factory.ts`
- Modify: `tests/unit/ai-provider-config.test.ts`
- Review: `tests/unit/workflow-provider-config.test.ts`
- Modify: `tests/unit/workflow-service-factory.test.ts`

- [ ] Write failing tests proving Codex needs no API key, exposes research and fast models, constructs no Responses provider, and routes both lanes to one Codex instance.
- [ ] Write failing resolver tests for trimmed `local|mock|trigger`, the unset local default, normalization of legacy `mock`, and rejection of unknown values.
- [ ] Run the focused tests and verify the failures describe the old hybrid behavior.
- [ ] Split OpenAI-only and Codex-only configuration resolution; retain strict bounds and local workflow restriction.
- [ ] Simplify the live bundle so each live mode selects one provider and its two configured models.
- [ ] Run the focused tests and typecheck.

### Task 2: Support sourced Codex web requests

**Files:**

- Modify: `src/lib/openai/providers/types.ts`
- Modify: `src/lib/openai/providers/responses-provider.ts`
- Modify: `src/lib/codex/structured-provider.ts`
- Modify: `src/modules/agents/types.ts`
- Modify: `src/modules/agents/provenance.ts`
- Modify: `src/modules/email-resolution/public-evidence-provider.ts`
- Modify: `tests/unit/codex-cli-provider.test.ts`
- Modify: `tests/unit/openai-responses-provider.test.ts`
- Modify: `tests/unit/agent-observability.test.ts`
- Modify: `tests/unit/agent-provenance.test.ts`
- Modify: `tests/unit/email-resolution.test.ts`

- [ ] Add failing tests using the observed `item.completed/web_search` shape.
- [ ] Assert web requests add `--search`, remove only `tools.web_search=false`, and retain all other hardening overrides.
- [ ] Assert the strict wire envelope `{output,sources:[{url,title}]}` with required nullable title, generated JSON Schema, HTTP(S) validation, de-duplication, search count, required provenance marker, and missing-search-evidence failures; an empty source list after a completed search remains valid.
- [ ] Run focused tests and verify RED.
- [ ] Implement request-dependent arguments/schema plus strict JSONL extraction without agent-specific logic.
- [ ] Mark Responses sources `tool_observed` and Codex citations `model_declared_after_search`, preserve the marker through `completeAgentRun`, and make provenance errors provider-neutral.
- [ ] Run focused tests and typecheck.

## Chunk 2: Product integration

### Task 3: Align routing, Settings, workflow naming, and documentation

**Files:**

- Review: `src/modules/agents/factory.ts` (modify only if a failing routing test requires it)
- Review: `src/modules/replies/classifier-factory.ts` (modify only if a failing routing test requires it)
- Review: `src/modules/workflows/service-factory.ts` (modify only if a failing routing test requires it)
- Modify: `src/modules/workflows/dispatcher-factory.ts`
- Modify: `src/modules/settings/provider-presentation.ts`
- Modify: `src/app/(operator)/settings/page.tsx`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-codex-cli-ai-provider-design.md`
- Modify: `docs/superpowers/plans/2026-08-12-codex-cli-ai-provider.md`
- Modify: `tests/unit/agent-factory.test.ts`
- Modify: `tests/unit/reply-classifier-factory.test.ts`
- Modify: `tests/unit/workflow-service-factory.test.ts`
- Modify: `tests/unit/provider-presentation.test.ts`
- Create: `tests/unit/workflow-provider-config.test.ts`

- [ ] Write failing routing and presentation tests for Codex research and provenance wording; resolver behavior is covered by Task 1.
- [ ] Run focused tests and verify RED.
- [ ] Apply the minimal factory/presentation changes; retain `mock` as a local-workflow compatibility alias and modify reviewed factories only when tests require it.
- [ ] Update operator documentation and environment examples without adding runtime UI mutation.
- [ ] Mark the 2026-08-12 hybrid design and plan as superseded by this delta so contradictory architecture is not presented as current.
- [ ] Run focused tests, typecheck, lint, and formatting.

### Task 4: Verify the assembled feature

**Files:**

- Review all files in this plan and the final diff.

- [ ] Run the full unit suite.
- [ ] Run integration tests, evaluation, build, and relevant E2E tests.
- [ ] Verify CLI help/config parsing accepts `--search` plus the exact hardening overrides without another model call; treat the user-provided 0.147.0 trace as the live search evidence and do not claim a live structured-output smoke unless one is run.
- [ ] Run targeted changed-file ESLint and Prettier; report unrelated `.claude` worktree contamination separately if global gates still fail.
- [ ] Audit no-fallback behavior, source semantics, secret isolation, local-only enforcement, and client import boundaries.
- [ ] Request spec and code-quality review; fix all blocking findings and rerun affected gates.
