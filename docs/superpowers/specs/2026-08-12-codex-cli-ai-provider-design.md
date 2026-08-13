# Codex CLI AI Provider Design

> **Superseded:** This hybrid-provider design is historical. The current design
> is [Codex CLI Web Research Design](./2026-08-13-codex-cli-web-research-design.md),
> where Codex handles web and non-web AI tasks and records weaker
> `model_declared_after_search` provenance explicitly.

**Date:** 2026-08-12
**Status:** Approved for implementation

## Goal

Let a local HyperOutreach operator opt into their authenticated Codex CLI / ChatGPT account for eligible AI work, while keeping the existing OpenAI Responses API and deterministic mock modes. The API remains the default production path.

## Product boundary

This is a local, single-operator capability. It is not a hosted multi-user entitlement bridge and must never expose the operator's Codex session to remote users.

Configuration is environment-first for this version:

- `OPENAI_PROVIDER=openai`: all AI work uses the Responses API.
- `OPENAI_PROVIDER=codex`: sourced web research continues through the Responses API; non-web tasks use the local Codex CLI.
- `OPENAI_PROVIDER=mock`: deterministic providers only.

The Settings page reports the configured mode and, in Codex mode, whether the CLI is installed and authenticated. It does not mutate `.env.local` or offer runtime provider switching.

## Why Codex mode is hybrid

HyperOutreach relies on first-class source provenance for company research, contact research, domain discovery, and public email evidence. The existing Responses provider records sources emitted by `web_search_call`. A local Codex JSONL probe could not be completed in the managed development sandbox, so equivalent source provenance is not established.

Therefore Codex mode is intentionally limited to tasks where `useWebSearch` is false:

- personalization generation;
- reply classification.

All tasks with `useWebSearch=true` remain on the Responses API. This is explicit routing, not a fallback.

## Architecture

Add a `CodexCliStructuredAIProvider` implementing the existing `StructuredAIProvider` contract. It:

1. rejects web-search requests;
2. converts the request's Zod schema to JSON Schema;
3. writes that schema into an isolated temporary directory;
4. launches `codex exec` with `spawn`, never a shell;
5. passes the prompt over stdin and requests JSONL plus structured output;
6. parses the final agent message and token usage;
7. validates the decoded payload again with the original Zod schema;
8. removes the temporary directory in all cases.

The invocation is non-interactive and constrained. In addition to the OS
sandbox, all model-callable local, network, plugin, app, hook, memory, and
subagent tools are disabled through explicit CLI config overrides. In
particular, both shell implementations are disabled; `read-only` alone is not
treated as a read-isolation boundary:

```text
codex exec
  --ephemeral
  --strict-config
  --ignore-user-config
  --ignore-rules
  --skip-git-repo-check
  --sandbox read-only
  -c features.shell_tool=false
  -c features.unified_exec=false
  -c features.view_image=false
  -c tools.web_search=false
  -c agents.enabled=false
  -c features.multi_agent=false
  -c features.hooks=false
  -c features.memories=false
  -c features.apps=false
  -c features.plugins=false
  -c features.remote_plugin=false
  -c features.auth_elicitation=false
  -c features.browser_use=false
  -c features.browser_use_external=false
  -c features.browser_use_full_cdp_access=false
  -c features.code_mode_host=false
  -c features.computer_use=false
  -c features.goals=false
  -c features.image_generation=false
  -c features.in_app_browser=false
  -c features.plugin_sharing=false
  -c features.shell_snapshot=false
  -c features.skill_mcp_dependency_install=false
  -c features.skill_search=false
  -c features.tool_call_mcp_elicitation=false
  -c features.tool_suggest=false
  -c features.workspace_dependencies=false
  -c apps._default.enabled=false
  -c project_doc_max_bytes=0
  --model <configured model>
  --output-schema <temporary schema path>
  --json
  -C <isolated temporary directory>
  -
```

The child receives an explicit environment allowlist containing only the
minimum process, locale, certificate, temporary-directory, and Codex-auth
location variables. Application secrets such as `OPENAI_API_KEY`, database
URLs, Microsoft credentials, and mail credentials are never inherited. The
supported CLI must accept the tool-disable overrides. `--strict-config` makes
an older/incompatible CLI or unknown key fail closed before any result is
accepted rather than running with weaker isolation.

The process runner enforces an end-to-end queue-and-execution timeout, a
combined output-size limit, and a process-wide concurrency semaphore. A queued
request that reaches its deadline is removed before it can spawn. The runner
kills failed children and returns sanitized errors without leaking prompts or
raw stderr. The executable and arguments are passed as separate values,
preventing shell injection. The default maximum concurrency is one.

A central provider bundle owns routing so every caller uses the same rules:

```text
mode=openai -> research: Responses, non-web: Responses
mode=codex  -> research: Responses, non-web: Codex CLI
mode=mock   -> deterministic providers
```

Agent construction is changed to accept separate research and non-web providers. Reply classification uses the non-web provider. Public evidence always receives the research provider.

Operational dependencies follow the same real-versus-mock boundary: `mock`
uses deterministic AI and DNS doubles, while both `openai` and `codex` use the
real DNS resolver and the Responses provider for sourced public evidence.

## Configuration

Existing OpenAI variables remain authoritative for API research:

- `OPENAI_PROVIDER` (`mock`, `openai`, or `codex`)
- `OPENAI_API_KEY`
- `OPENAI_RESEARCH_MODEL`
- `OPENAI_FAST_MODEL`

Codex mode adds:

- `CODEX_EXECUTABLE` (default: `codex`)
- `CODEX_FAST_MODEL` (default: the configured `OPENAI_FAST_MODEL`)
- `CODEX_TIMEOUT_MS` (bounded positive integer; conservative default)
- `CODEX_MAX_CONCURRENCY` (bounded positive integer; default: `1`)

Because Codex mode still performs sourced research through Responses, it requires `OPENAI_API_KEY`. Startup errors explain this hybrid requirement. `OPENAI_PROVIDER` is validated strictly; values other than `mock`, `openai`, or `codex` fail configuration instead of silently selecting mocks. There is no silent fallback from Codex to the API or from the API to Codex.

Codex mode also requires local workflow execution. It is rejected when
`WORKFLOW_PROVIDER=trigger`, because a hosted Trigger worker cannot use or be
validated against the operator machine's CLI binary and ChatGPT login.

## Status and observability

A lightweight status check runs `codex login status` with a short timeout and reports one of:

- authenticated;
- installed but not authenticated;
- unavailable.

The Settings page never displays account identifiers, tokens, full stderr, or prompts. Codex-backed agents are constructed with an audit model prefixed by `codex-cli:` before `startAgentRun` is called; the provider strips this prefix only when passing the raw model identifier to the CLI. Successful and failed runs therefore retain the execution path without a schema migration.

Codex token usage is captured when present in JSONL. Dollar cost is marked unavailable because ChatGPT-plan consumption is not equivalent to API metering.

## Failure semantics

Codex failures are explicit and fail the current task. They do not silently consume API credits. Expected failures include a missing executable, unauthenticated CLI, timeout, non-zero exit, malformed JSONL, missing final message, and schema-invalid output.

The CLI provider supplies no web sources and reports zero web-search calls. Attempting to route a web-search request to it is a programming error covered by tests.

## Testing

Tests use an injected process runner; they do not depend on a real ChatGPT session. Coverage includes:

- exact safe arguments and stdin prompt transport;
- child-environment allowlisting and disabled model-callable tools;
- valid JSONL/result parsing and usage extraction;
- Zod re-validation;
- rejection of web-search work;
- non-zero, strict-configuration, malformed, oversized, and timeout process failures;
- provider routing for `openai`, `codex`, and `mock`;
- invalid provider rejection, real DNS selection, and concurrency limiting;
- Codex status mapping;
- Settings presentation of hybrid mode.

The implementation follows red-green-refactor and then runs the repository's full lint, typecheck, test, build, and evaluation gates.

## Deliberately out of scope

- hosted multi-user Codex authentication;
- OAuth/token extraction from ChatGPT;
- editing `.env.local` from the UI;
- per-run or per-agent dynamic switching;
- automatic fallback between providers;
- Codex-backed sourced web research until provenance is independently verified;
- database migrations solely to add a provider field.
