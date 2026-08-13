# Codex CLI AI Provider Implementation Plan

> **Superseded:** This hybrid-provider plan is retained as implementation
> history. The current plan is
> [Codex CLI Web Research Implementation Plan](./2026-08-13-codex-cli-web-research.md).

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, local Codex CLI path for non-web AI tasks while retaining the Responses API for sourced research and deterministic mocks for development.

**Architecture:** Strict configuration produces separate research and non-web lanes. A server-only Codex CLI adapter implements the existing structured-provider contract with schema validation, disabled tools, filtered environment, shared concurrency, and no fallback; workflows construct one provider bundle and inject it into their agents and classifier. Settings reports the hybrid mode and a sanitized CLI status.

**Tech Stack:** TypeScript, Node.js `child_process`, Zod 4 JSON Schema, OpenAI Responses API, Next.js 16 server components, Vitest.

---

## Chunk 1: Provider implementation and integration

The approved design is `docs/superpowers/specs/2026-08-12-codex-cli-ai-provider-design.md`. `.git` is read-only in this environment, so the normal worktree and commit steps are explicitly unavailable; preserve the initially clean checkout and inspect the final diff.

### Task 1: Shared provider types and strict configuration

**Files:**

- Create: `src/lib/openai/providers/types.ts`
- Create: `src/lib/openai/provider-config.ts`
- Create: `src/lib/openai/provider-bundle.ts`
- Modify: `src/lib/openai/providers/responses-provider.ts`
- Modify: `src/modules/agents/openai-agents.ts`
- Test: `tests/unit/ai-provider-config.test.ts`

- [ ] **Step 1: Write failing tests for strict mode parsing and an injected bundle**

Test these public contracts:

```ts
type AIProviderMode = "mock" | "openai" | "codex";

type ResolvedAIProviderConfig =
  | { mode: "mock"; usesRealInfrastructure: false }
  | {
      mode: "openai";
      usesRealInfrastructure: true;
      openai: { apiKey: string; researchModel: string; fastModel: string };
    }
  | {
      mode: "codex";
      usesRealInfrastructure: true;
      openai: { apiKey: string; researchModel: string; fastModel: string };
      codex: {
        executable: string;
        fastModel: string;
        timeoutMs: number;
        maxConcurrency: number;
      };
    };

type LiveAIProviderBundle = {
  mode: "openai" | "codex";
  usesRealInfrastructure: true;
  research: { provider: StructuredAIProvider; model: string };
  nonWeb: { provider: StructuredAIProvider; model: string };
};

type AIProviderBundle =
  { mode: "mock"; usesRealInfrastructure: false } | LiveAIProviderBundle;
```

Assert empty mode is `mock`, all three valid modes resolve correctly, Codex still requires `OPENAI_API_KEY`, Codex defaults `maxConcurrency` to `1`, numeric limits reject zero/non-integers/out-of-range values, and unknown mode throws `AIProviderConfigurationError` rather than selecting mock. Test `createLiveAIProviderBundle(config, factories)` with injected provider doubles only; production Codex construction belongs to Task 2.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/unit/ai-provider-config.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Move the provider contract to the library boundary**

Define in `providers/types.ts`:

```ts
export interface StructuredAIProvider {
  run<T>(
    request: StructuredResponseRequest<T>,
  ): Promise<StructuredResponseResult<T>>;
}
```

Move/re-export the existing request/result types without changing their fields. Update Responses and agent imports; do not change behavior.

- [ ] **Step 4: Implement strict configuration and the pure injected bundle**

Implement `resolveAIProviderConfig(environment)` with bounded helpers. Preserve `gpt-5.6-terra` and `gpt-5.6-luna` defaults. Use conservative constants `CODEX_TIMEOUT_MS=120000`, maximum timeout `600000`, default concurrency `1`, and maximum concurrency `8`. Prefix only the Codex non-web audit model as `codex-cli:<raw-model>`.

Implement:

```ts
export function createLiveAIProviderBundle(
  config: Exclude<ResolvedAIProviderConfig, { mode: "mock" }>,
  factories: {
    responses(openai: OpenAIConfig): StructuredAIProvider;
    codex?(codex: CodexConfig): StructuredAIProvider;
  },
): LiveAIProviderBundle;
```

OpenAI mode uses the same Responses provider instance for both lanes. Codex mode uses Responses for research and the injected Codex provider for non-web. Missing Codex factory is a configuration error.

- [ ] **Step 5: Run focused regressions and verify GREEN**

Run: `npm test -- --run tests/unit/ai-provider-config.test.ts tests/unit/openai-responses-provider.test.ts tests/unit/agents.test.ts`

Expected: PASS.

### Task 2: Hardened server-only Codex process and structured provider

**Files:**

- Create: `src/lib/codex/process-runner.ts`
- Create: `src/lib/codex/concurrency.ts`
- Create: `src/lib/codex/structured-provider.ts`
- Create: `src/lib/openai/production-provider-bundle.ts`
- Modify: `src/lib/openai/client.ts`
- Test: `tests/unit/codex-cli-provider.test.ts`

- [ ] **Step 1: Write RED tests for the process boundary**

Define an injectable runner boundary:

```ts
export type ProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  environment: Record<string, string>;
};

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
```

Test `NodeProcessRunner` with a harmless Node child fixture for success, timeout plus child termination, stdout/stderr combined size overflow plus child termination, and sanitized typed errors. Production model calls use a fixed combined output cap of `1_048_576` bytes. Test `codexChildEnvironment(process.env)` copies only these exact keys when present: `PATH`, `HOME`, `CODEX_HOME`, `TMPDIR`, `TMP`, `TEMP`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `SystemRoot`, `WINDIR`, `COMSPEC`, and `PATHEXT`. Do not use prefix globs (including `LC_*`) or inherit proxies/arbitrary platform variables. Assert `OPENAI_API_KEY`, database, Microsoft, mail, proxy credentials, and unknown variables are absent.

- [ ] **Step 2: Write RED tests for provider lifecycle and cleanup**

With an injected fake runner, assert:

- `useWebSearch=true` rejects before running;
- exact arguments include `--ephemeral`, `--strict-config`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `--sandbox read-only`, `--json`, stdin marker `-`, and these overrides:

```text
features.shell_tool=false
features.unified_exec=false
features.view_image=false
tools.web_search=false
agents.enabled=false
features.multi_agent=false
features.hooks=false
features.memories=false
features.apps=false
features.plugins=false
features.remote_plugin=false
apps._default.enabled=false
```

- prompt content appears only in `stdin`, never executable/args;
- the temporary cwd contains only `output-schema.json` while running;
- the temporary directory is removed after both success and failure;
- `codex-cli:` is stripped only from the raw `--model` argument;
- JSONL events shaped as `thread.started`, `item.completed` with `item.type="agent_message"`, and `turn.completed` with snake-case usage produce the expected result;
- successful results retain `model: "codex-cli:<raw-model>"` even though the raw model is passed to the CLI;
- final output is Zod-validated, sources are `[]`, web calls are `0`, and cost is unavailable;
- non-zero/strict-config failure, malformed JSONL, missing message, invalid JSON, and invalid schema output raise typed errors that omit prompt and stderr.

- [ ] **Step 3: Write RED cross-instance concurrency test**

Construct two provider instances with `maxConcurrency=1` and a blocking runner. Assert only one runner invocation begins until the first releases. This requires `getSharedCodexSemaphore(maxConcurrency)` to return a module-level shared semaphore, not one owned by a bundle/provider instance.

- [ ] **Step 4: Run tests and verify RED**

Run: `npm test -- --run tests/unit/codex-cli-provider.test.ts`

Expected: FAIL because the Codex modules do not exist.

- [ ] **Step 5: Implement the runner, shared semaphore, and provider minimally**

Mark all four production modules with `import "server-only";`. Use `spawn(executable, args, { shell: false, cwd, env })`; stream/cap both outputs, kill once on timeout/overflow, and settle once. Use `mkdtemp`, `writeFile`, `rm({recursive:true,force:true})` in `finally`. Generate the schema with `z.toJSONSchema(request.outputSchema)`. Parse JSONL one line at a time and use only the final `agent_message` text as JSON input to the original Zod schema.

Implement `createProductionAIProviderBundle(environment): AIProviderBundle` by resolving config. For mock, return the mock member without constructing OpenAI/Codex objects or requiring credentials. For either live mode, construct one OpenAI client/Responses provider; inject `CodexCliStructuredAIProvider` only for Codex mode. Do not create a Codex process during bundle construction.

- [ ] **Step 6: Run targeted tests and typecheck**

Run: `npm test -- --run tests/unit/codex-cli-provider.test.ts tests/unit/ai-provider-config.test.ts tests/unit/openai-responses-provider.test.ts`

Run: `npm run typecheck`

Expected: PASS.

All tests importing a module marked `server-only` must place the repository's established `vi.mock("server-only", () => ({}))` before the dynamic import under test, as in `tests/unit/db-client.test.ts`.

### Task 3: Inject one bundle through agents, replies, DNS, and workflows

**Files:**

- Modify: `src/modules/agents/factory.ts`
- Modify: `src/modules/replies/classifier-factory.ts`
- Modify: `src/modules/workflows/service-factory.ts`
- Test: `tests/unit/agent-factory.test.ts`
- Test: `tests/unit/reply-classifier-factory.test.ts`
- Test: `tests/unit/workflow-service-factory.test.ts`

- [ ] **Step 1: Write RED agent and classifier routing tests**

Test these exact signatures:

```ts
export function createAgentSetFromBundle(bundle: AIProviderBundle): AgentSet;

export function createAgentSet(
  environment?: Record<string, string | undefined>,
): AgentSet; // thin production wrapper

export function createReplyClassifierFromBundle(
  bundle: AIProviderBundle,
): ReplyClassifier;
```

Assert Codex research agents use Responses and personalization uses Codex; reply classification uses the non-web lane; OpenAI uses Responses everywhere; mock stays deterministic. Assert the Codex personalization/classifier observable model is already `codex-cli:<model>` so failed `agent_runs` are auditable. Have a Codex provider double throw and assert no Responses call follows.

Add an observability assertion covering `startAgentRun` plus `completeAgentRun`: both a successful Codex result and a failed Codex run must persist `codex-cli:<model>`, preventing `completeAgentRun` from erasing the audit prefix.

- [ ] **Step 2: Write RED workflow infrastructure tests**

Add optional workflow dependencies:

```ts
type WorkflowProviderDependencies = {
  createBundle(environment: Environment): AIProviderBundle;
  createRealDns(): DnsMxResolver;
  createMockDns(): DnsMxResolver;
};
```

Assert `createWorkflowTaskServices` calls `createBundle` exactly once, passes that same instance to agent/classifier builders, selects real DNS and Responses public evidence for both `openai` and `codex`, and selects mock DNS/static evidence only for mock. Test failure without fallback.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- --run tests/unit/agent-factory.test.ts tests/unit/reply-classifier-factory.test.ts tests/unit/workflow-service-factory.test.ts`

Expected: FAIL against the current duplicated factories.

- [ ] **Step 4: Implement bundle injection and remove duplicate OpenAI construction**

`createWorkflowTaskServices` must construct exactly one bundle, call `createAgentSetFromBundle(bundle)` and `createReplyClassifierFromBundle(bundle)`, and use `bundle.usesRealInfrastructure` for DNS/public-evidence selection. Keep `createAgentSet(environment)` and `createReplyClassifier(environment)` as server-only wrappers for existing standalone callers.

- [ ] **Step 5: Run focused regression tests and verify GREEN**

Run: `npm test -- --run tests/unit/agent-factory.test.ts tests/unit/reply-classifier-factory.test.ts tests/unit/workflow-service-factory.test.ts tests/unit/agents.test.ts tests/unit/email-resolution.test.ts`

Expected: PASS.

Tests importing the server-only factory wrappers must mock `server-only` before dynamic import; pure `*FromBundle` tests should import only process-free modules when possible.

### Task 4: Sanitized status, Settings presentation, and documentation

**Files:**

- Create: `src/lib/codex/status.ts`
- Create: `src/modules/settings/provider-presentation.ts`
- Modify: `src/app/(operator)/settings/page.tsx`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `tests/unit/codex-status.test.ts`
- Test: `tests/unit/provider-presentation.test.ts`

- [ ] **Step 1: Write RED status tests**

Define:

```ts
type CodexCliStatus = "authenticated" | "not_authenticated" | "unavailable";

export async function getCodexCliStatus(
  executable: string,
  runner?: ProcessRunner,
): Promise<CodexCliStatus>;
```

Assert `codex login status` with a short timeout maps recognized `Logged in` success to `authenticated`, recognized `Not logged in` to `not_authenticated`, and missing executable, timeout, unknown non-zero output, or malformed response to `unavailable`. Assert no raw stdout/stderr/account detail escapes and the filtered environment is used.

- [ ] **Step 2: Write RED pure-presentation and invocation tests**

In a `.test.ts` file collected by the existing Vitest config, test `getProviderPresentation(config, codexStatus?)` returns plain labels/models/status. Codex copy must say “ChatGPT/Codex for non-web tasks + API for sourced research.” Add a page-level helper `statusForProvider(config, statusLoader)` and assert the loader is called once only for Codex, never for mock/OpenAI.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- --run tests/unit/codex-status.test.ts tests/unit/provider-presentation.test.ts`

Expected: FAIL because status/presentation modules do not exist.

- [ ] **Step 4: Implement server-only status and Settings integration**

Mark `status.ts` with `import "server-only";` and reuse the safe runner. Keep `provider-presentation.ts` pure and process-free. The server page resolves config, conditionally loads Codex status, and renders only presentation fields. It must not make a model call, mutate environment files, display account identity, or expose secrets.

- [ ] **Step 5: Document the supported local mode**

Add `.env.example` entries for `OPENAI_PROVIDER=mock|openai|codex`, `CODEX_EXECUTABLE`, `CODEX_FAST_MODEL`, `CODEX_TIMEOUT_MS`, and `CODEX_MAX_CONCURRENCY`. Document the hybrid API-key requirement, `codex login` prerequisite, local single-operator boundary, source-provenance routing, no fallback, and unavailable dollar-cost semantics.

- [ ] **Step 6: Run targeted tests, typecheck, and build**

Run: `npm test -- --run tests/unit/codex-status.test.ts tests/unit/provider-presentation.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: PASS.

### Task 5: Full verification and final audit

**Files:** Modify only files required to fix verified regressions.

- [ ] **Step 1: Format the implementation**

Run: `npm run format`

Expected: Prettier completes successfully.

- [ ] **Step 2: Run static gates**

Run: `npm run format:check && npm run lint && npm run typecheck`

Expected: PASS with zero warnings.

- [ ] **Step 3: Run database-backed and browser gates**

Run: `npm run db:up`

Run: `npm test`

Run: `npm run test:integration`

Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 4: Run product/evaluation gates**

Run: `npm run eval`

Run: `npm run db:check`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Audit the final diff against the design**

Confirm no secret/account detail is rendered or logged; `OPENAI_API_KEY` cannot reach the Codex child; no shell or prompt interpolation exists; model-callable tools are disabled with strict config; web/source tasks cannot reach Codex; Codex failures cannot trigger API fallback; successful and failed runs retain `codex-cli:`; the process-wide semaphore works across instances; and only requested provider/configuration/routing/status/tests/docs changed.
