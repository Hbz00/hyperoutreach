# Codex CLI Web Research Design

## Goal

Make `OPENAI_PROVIDER=codex` a complete local provider: Codex CLI handles both
web research and non-web tasks through the operator's ChatGPT authentication.
The OpenAI API remains a separate provider, not a hidden dependency or fallback.

## Observed CLI contract

A real Codex CLI 0.147.0 probe using `--search --json` emitted:

- `item.completed` with `item.type="web_search"`, a stable item ID, and the
  executed search query;
- a final `agent_message` containing the cited URL;
- token usage in `turn.completed`.

The web-search event did not expose result URLs. Therefore Codex proves that a
search occurred and records its query, but citations must be returned in the
structured model output. They are not equivalent to Responses API sources,
which are observed directly in `web_search_call.action.sources`.

## Provider modes

- `mock`: deterministic local doubles and no credentials.
- `openai`: one Responses provider handles every AI request.
- `codex`: one hardened Codex CLI provider handles every AI request locally.

Codex mode no longer constructs an OpenAI client or requires `OPENAI_API_KEY`.
There is no automatic fallback between providers. Codex remains incompatible
with `WORKFLOW_PROVIDER=trigger`, because the hosted worker cannot use the
operator machine's CLI installation and login.

## Configuration

Codex mode uses:

- `CODEX_EXECUTABLE`;
- `CODEX_RESEARCH_MODEL`, defaulting to `OPENAI_RESEARCH_MODEL` for backward
  compatibility with the existing model defaults;
- `CODEX_FAST_MODEL`, defaulting to `OPENAI_FAST_MODEL`;
- `CODEX_TIMEOUT_MS`;
- `CODEX_MAX_CONCURRENCY`.

The OpenAI key and client are resolved only in OpenAI mode. The existing
`OPENAI_RESEARCH_MODEL` and `OPENAI_FAST_MODEL` values remain model-name
fallbacks in Codex mode for configuration compatibility; they do not cause an
API client or API request to be created.

## Web-search invocation

The existing process runner, semaphore, temporary directory, environment
allowlist, JSONL parser, output limit, timeout, and disabled capabilities remain
shared by both request types.

For `useWebSearch=false`, Codex runs with web search disabled exactly as today.
For `useWebSearch=true`, the provider:

1. adds the global `--search` flag before `exec`;
2. omits the conflicting `tools.web_search=false` override;
3. keeps every unrelated local, app, plugin, browser, shell, memory, and
   subagent capability disabled;
4. requests a generic structured envelope containing `output` and `sources`;
5. counts completed, uniquely identified `web_search` items;
6. validates the business `output` with the caller's existing Zod schema;
7. validates and de-duplicates HTTP(S) citations before returning them.

The envelope is provider infrastructure, not an agent-specific schema. Its wire
shape keeps every property required for Codex strict-schema compatibility;
`title: null` is normalized to an omitted domain title:

```ts
{
  output: T;
  sources: Array<{ url: string; title: string | null }>;
}
```

This intentionally duplicates source URLs already present in some business
outputs, just as Responses separates tool-observed provider sources from the
model's structured evidence. Existing provenance validators continue checking
that business evidence URLs occur in `result.sources`.

Each live provider source includes a required persisted provenance marker:

- Responses: `tool_observed`;
- Codex web research: `model_declared_after_search`.

This requires no database migration because `agent_runs.sources` is JSONB.

## Failure semantics

A Codex web request fails closed when:

- no completed web-search event is present;
- a completed web-search event lacks a usable query or stable item ID;
- the structured envelope is missing or invalid;
- any returned citation is not an HTTP(S) URL;
- the business output fails its existing schema;
- the CLI fails, times out, or exceeds its output bound.

An empty citation list is valid only when the business output contains no
sourced claims. Existing domain provenance validators reject an output that
makes sourced claims whose evidence URLs are absent from the provider source
list.

Unknown JSONL event types may be ignored for forward compatibility, but malformed
known events used for provenance are rejected. Citations are explicitly treated
as model-declared-after-search, never as tool-observed results.

## Workflow provider terminology

`WORKFLOW_PROVIDER` is orthogonal to `OPENAI_PROVIDER`; it selects the workflow
executor, not the AI model. `trigger` dispatches durable work to Trigger.dev.
The current `mock` value executes the real local PostgreSQL-backed dispatcher,
so its name is misleading. A single `resolveWorkflowProvider()` normalizes an
unset value or the legacy `mock` value to `local`, accepts `local|mock|trigger`
strictly after trimming, and rejects unknown values. The dispatcher, Codex
compatibility check, and Settings use this same resolver. Renaming internal
classes or removing `mock` is out of scope.

## Tests

Tests cover:

- Codex mode without an API key or OpenAI client construction;
- full Codex routing for research and non-web tasks;
- exact `--search`/override behavior;
- the observed Codex 0.147.0 web-search JSONL shape;
- source validation, de-duplication, required provenance marker, and call count;
- valid empty search results and fail-closed behavior when the completed search
  evidence is missing;
- no fallback;
- `WORKFLOW_PROVIDER=local` and legacy `mock` selecting local execution;
- Settings and documentation describing the complete Codex mode accurately.

## Out of scope

- claiming Codex citations are tool-observed URLs;
- validating that a URL appeared in the hidden search result set;
- per-task provider selection;
- fallback between Codex and Responses;
- hosted access to a user's local ChatGPT session;
- database migrations;
- refactoring the durable workflow subsystem.
