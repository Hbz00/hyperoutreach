import { describe, expect, it, vi } from "vitest";

import {
  AIProviderConfigurationError,
  resolveAIProviderConfig,
  type AIProviderMode,
  type ResolvedAIProviderConfig,
} from "@/lib/openai/provider-config";
import {
  createLiveAIProviderBundle,
  type AIProviderBundle,
} from "@/lib/openai/provider-bundle";
import type { StructuredAIProvider } from "@/lib/openai/providers/types";

function providerDouble(label: string): StructuredAIProvider {
  return {
    run: vi.fn(async () => {
      throw new Error(`${label} should not run in a bundle construction test`);
    }),
  };
}

describe("AI provider configuration", () => {
  it("defaults an empty environment and resolves explicit mock mode", () => {
    const expectedMode: AIProviderMode = "mock";
    const config: ResolvedAIProviderConfig = resolveAIProviderConfig({});
    const explicitConfig = resolveAIProviderConfig({
      OPENAI_PROVIDER: " mock ",
    });

    expect(config).toEqual({
      mode: expectedMode,
      usesRealInfrastructure: false,
    });
    expect(explicitConfig).toEqual(config);
  });

  it("resolves OpenAI mode with trimmed values and stable model defaults", () => {
    expect(
      resolveAIProviderConfig({
        OPENAI_PROVIDER: " openai ",
        OPENAI_API_KEY: " secret-key ",
      }),
    ).toEqual({
      mode: "openai",
      usesRealInfrastructure: true,
      openai: {
        apiKey: "secret-key",
        researchModel: "gpt-5.6-terra",
        fastModel: "gpt-5.6-luna",
      },
    });
  });

  it("resolves Codex without an API key and exposes both model lanes", () => {
    expect(
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
      }),
    ).toEqual({
      mode: "codex",
      usesRealInfrastructure: true,
      codex: {
        executable: "codex",
        researchModel: "gpt-5.6-terra",
        fastModel: "gpt-5.6-luna",
        timeoutMs: 240_000,
        maxConcurrency: 1,
      },
    });
  });

  it.each([undefined, "", "mock"])(
    "allows Codex with local workflow execution (%s)",
    (workflowProvider) => {
      expect(
        resolveAIProviderConfig({
          OPENAI_PROVIDER: "codex",
          WORKFLOW_PROVIDER: workflowProvider,
        }),
      ).toMatchObject({ mode: "codex", usesRealInfrastructure: true });
    },
  );

  it("rejects Codex when workflows run in a hosted Trigger worker", () => {
    expect(() =>
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
        WORKFLOW_PROVIDER: " trigger ",
      }),
    ).toThrowError(AIProviderConfigurationError);
    expect(() =>
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
        WORKFLOW_PROVIDER: " trigger ",
      }),
    ).toThrowError(/local workflow execution/i);
  });

  it("accepts explicit Codex settings within their bounds", () => {
    expect(
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
        OPENAI_RESEARCH_MODEL: "research-custom",
        OPENAI_FAST_MODEL: "api-fast",
        CODEX_RESEARCH_MODEL: "codex-research",
        CODEX_EXECUTABLE: "/opt/homebrew/bin/codex",
        CODEX_FAST_MODEL: "codex-fast",
        CODEX_TIMEOUT_MS: "600000",
        CODEX_MAX_CONCURRENCY: "8",
      }),
    ).toEqual({
      mode: "codex",
      usesRealInfrastructure: true,
      codex: {
        executable: "/opt/homebrew/bin/codex",
        researchModel: "codex-research",
        fastModel: "codex-fast",
        timeoutMs: 600_000,
        maxConcurrency: 8,
      },
    });
  });

  it("uses OpenAI model variables as compatibility fallbacks for Codex", () => {
    expect(
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
        OPENAI_RESEARCH_MODEL: "legacy-research",
        OPENAI_FAST_MODEL: "legacy-fast",
      }),
    ).toMatchObject({
      codex: {
        researchModel: "legacy-research",
        fastModel: "legacy-fast",
      },
    });
  });

  it("requires an API key only in OpenAI mode", () => {
    expect(() =>
      resolveAIProviderConfig({ OPENAI_PROVIDER: "openai" }),
    ).toThrowError(AIProviderConfigurationError);
    expect(() =>
      resolveAIProviderConfig({ OPENAI_PROVIDER: "codex" }),
    ).not.toThrow();
  });

  it("rejects unknown provider modes instead of silently selecting mocks", () => {
    expect(() =>
      resolveAIProviderConfig({ OPENAI_PROVIDER: "local-ish" }),
    ).toThrowError(AIProviderConfigurationError);
  });

  it.each([
    ["CODEX_TIMEOUT_MS", "0"],
    ["CODEX_TIMEOUT_MS", "600001"],
    ["CODEX_TIMEOUT_MS", "1.5"],
    ["CODEX_TIMEOUT_MS", "not-a-number"],
    ["CODEX_MAX_CONCURRENCY", "0"],
    ["CODEX_MAX_CONCURRENCY", "9"],
    ["CODEX_MAX_CONCURRENCY", "1.5"],
  ])("rejects invalid bounded integer %s=%s", (key, value) => {
    expect(() =>
      resolveAIProviderConfig({
        OPENAI_PROVIDER: "codex",
        [key]: value,
      }),
    ).toThrowError(AIProviderConfigurationError);
  });
});

describe("live AI provider bundle", () => {
  it("uses one Responses provider instance for both OpenAI lanes", () => {
    const responsesProvider = providerDouble("responses");
    const responses = vi.fn(() => responsesProvider);
    const config = resolveAIProviderConfig({
      OPENAI_PROVIDER: "openai",
      OPENAI_API_KEY: "api-key",
      OPENAI_RESEARCH_MODEL: "research-model",
      OPENAI_FAST_MODEL: "fast-model",
    });
    if (config.mode !== "openai") throw new Error("unexpected test config");

    const bundle: AIProviderBundle = createLiveAIProviderBundle(config, {
      responses,
    });

    expect(responses).toHaveBeenCalledOnce();
    expect(bundle).toMatchObject({
      mode: "openai",
      usesRealInfrastructure: true,
      research: { model: "research-model" },
      nonWeb: { model: "fast-model" },
    });
    expect(bundle.research.provider).toBe(responsesProvider);
    expect(bundle.nonWeb.provider).toBe(responsesProvider);
  });

  it("uses one Codex instance for both lanes and never constructs Responses", () => {
    const codexProvider = providerDouble("codex");
    const responses = vi.fn(() => providerDouble("responses"));
    const codex = vi.fn(() => codexProvider);
    const config = resolveAIProviderConfig({
      OPENAI_PROVIDER: "codex",
      CODEX_RESEARCH_MODEL: "codex-research",
      CODEX_FAST_MODEL: "codex-fast",
    });
    if (config.mode !== "codex") throw new Error("unexpected test config");

    const bundle = createLiveAIProviderBundle(config, { responses, codex });

    expect(responses).not.toHaveBeenCalled();
    expect(codex).toHaveBeenCalledOnce();
    expect(codex).toHaveBeenCalledWith(config.codex);
    expect(bundle).toEqual({
      mode: "codex",
      usesRealInfrastructure: true,
      research: {
        provider: codexProvider,
        model: "codex-cli:codex-research",
        operationTimeoutMs: 240_000,
      },
      nonWeb: {
        provider: codexProvider,
        model: "codex-cli:codex-fast",
      },
    });
  });

  it("rejects Codex configuration without an injected Codex factory", () => {
    const config = resolveAIProviderConfig({
      OPENAI_PROVIDER: "codex",
    });
    if (config.mode !== "codex") throw new Error("unexpected test config");

    expect(() =>
      createLiveAIProviderBundle(config, {
        responses: () => providerDouble("responses"),
      }),
    ).toThrowError(AIProviderConfigurationError);
  });
});
