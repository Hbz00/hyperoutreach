import { describe, expect, it, vi } from "vitest";

import type { ResolvedAIProviderConfig } from "@/lib/openai/provider-config";
import {
  getProviderPresentation,
  resolveProviderPresentation,
  statusForProvider,
} from "@/modules/settings/provider-presentation";

const mockConfig = {
  mode: "mock",
  usesRealInfrastructure: false,
} satisfies ResolvedAIProviderConfig;

const openAIConfig = {
  mode: "openai",
  usesRealInfrastructure: true,
  openai: {
    apiKey: "not-presented",
    researchModel: "research-model",
    fastModel: "fast-model",
  },
} satisfies ResolvedAIProviderConfig;

const codexConfig = {
  mode: "codex",
  usesRealInfrastructure: true,
  codex: {
    executable: "/opt/codex",
    researchModel: "codex-research-model",
    fastModel: "codex-fast-model",
    timeoutMs: 120_000,
    maxConcurrency: 1,
  },
} satisfies ResolvedAIProviderConfig;

describe("getProviderPresentation", () => {
  it("presents deterministic mock mode without live model names", () => {
    expect(getProviderPresentation(mockConfig)).toEqual({
      provider: "Deterministic mock",
      researchModel: "deterministic-mock",
      nonWebModel: "deterministic-mock",
      codexStatus: undefined,
      workflowProvider: "Local",
    });
  });

  it("presents OpenAI Responses models without exposing the API key", () => {
    const presentation = getProviderPresentation(openAIConfig);

    expect(presentation).toEqual({
      provider: "OpenAI Responses API",
      researchModel: "research-model",
      nonWebModel: "fast-model",
      codexStatus: undefined,
      workflowProvider: "Local",
    });
    expect(JSON.stringify(presentation)).not.toContain("not-presented");
  });

  it.each([
    ["authenticated", "Authenticated"],
    ["not_authenticated", "Installed, not authenticated"],
    ["unavailable", "Unavailable"],
  ] as const)(
    "presents fully local Codex mode with %s status",
    (status, label) => {
      const presentation = getProviderPresentation(codexConfig, status);

      expect(presentation).toEqual({
        provider: "Local Codex CLI / ChatGPT account for all AI tasks",
        researchModel: "codex-research-model",
        nonWebModel: "codex-fast-model",
        codexStatus: label,
        codexStatusNote:
          "Login status only; hardened Codex invocations can still fail closed if the installed CLI is incompatible.",
        sourceProvenanceNote:
          "Web citations are model-declared after an observed Codex search, not tool-observed.",
        workflowProvider: "Local",
      });
      expect(JSON.stringify(presentation)).not.toContain("OpenAI API");
    },
  );

  it("presents Trigger.dev when the resolved workflow provider is Trigger", () => {
    expect(
      getProviderPresentation(openAIConfig, undefined, "trigger"),
    ).toMatchObject({ workflowProvider: "Trigger.dev" });
  });
});

describe("resolveProviderPresentation", () => {
  it.each([
    {
      name: "an unknown provider",
      environment: {
        OPENAI_PROVIDER: "unknown",
        OPENAI_API_KEY: "must-not-leak",
      },
    },
    {
      name: "an invalid Codex bound",
      environment: {
        OPENAI_PROVIDER: "codex",
        CODEX_TIMEOUT_MS: "999999",
      },
    },
    {
      name: "Codex with hosted Trigger workflows",
      environment: {
        OPENAI_PROVIDER: "codex",
        WORKFLOW_PROVIDER: "trigger",
      },
    },
    {
      name: "an unknown workflow provider",
      environment: {
        OPENAI_PROVIDER: "openai",
        OPENAI_API_KEY: "must-not-leak",
        WORKFLOW_PROVIDER: "somewhere",
      },
    },
  ])(
    "sanitizes $name without checking Codex status",
    async ({ environment }) => {
      const loader = vi.fn();

      const presentation = await resolveProviderPresentation(
        environment,
        loader,
      );

      expect(presentation).toEqual({
        provider: "Misconfigured",
        researchModel: "Unavailable",
        nonWebModel: "Unavailable",
        codexStatus: undefined,
        workflowProvider: "Misconfigured",
        configurationNotice:
          "Provider configuration is invalid. Check the server environment.",
      });
      expect(JSON.stringify(presentation)).not.toContain("must-not-leak");
      expect(JSON.stringify(presentation)).not.toContain("999999");
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, "Local"],
    [{ WORKFLOW_PROVIDER: "mock" }, "Local"],
    [
      {
        OPENAI_PROVIDER: "openai",
        OPENAI_API_KEY: "not-presented",
        WORKFLOW_PROVIDER: "trigger",
      },
      "Trigger.dev",
    ],
  ] as const)(
    "uses the shared workflow resolver for %o",
    async (environment, workflowProvider) => {
      await expect(
        resolveProviderPresentation(environment, vi.fn()),
      ).resolves.toMatchObject({ workflowProvider });
    },
  );

  it("rethrows unexpected resolver errors", async () => {
    const unexpected = new Error("unexpected failure");
    const loader = vi.fn();

    await expect(
      resolveProviderPresentation({}, loader, () => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("statusForProvider", () => {
  it.each([mockConfig, openAIConfig])(
    "does not inspect Codex for $mode mode",
    async (config) => {
      const loader = vi.fn();

      await expect(statusForProvider(config, loader)).resolves.toBeUndefined();
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it("loads status once with the configured executable only in Codex mode", async () => {
    const loader = vi.fn().mockResolvedValue("authenticated");

    await expect(statusForProvider(codexConfig, loader)).resolves.toBe(
      "authenticated",
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith("/opt/codex");
  });
});
