import { describe, expect, it } from "vitest";

import type { ResolvedAIProviderConfig } from "@/lib/ai/provider-config";
import {
  getProviderPresentation,
  resolveProviderPresentation,
} from "@/modules/settings/provider-presentation";

const mockConfig = {
  mode: "mock",
  usesRealInfrastructure: false,
} satisfies ResolvedAIProviderConfig;

const desktopConfig = {
  mode: "chatgpt_desktop",
  usesRealInfrastructure: true,
  chatGptDesktop: {
    research: { model: "GPT-5.6 Sol", effort: "High", timeoutMs: 600_000 },
    fast: { model: "GPT-5.6 Sol", effort: "Instant", timeoutMs: 120_000 },
  },
} satisfies ResolvedAIProviderConfig;

describe("getProviderPresentation", () => {
  it("presents deterministic mock mode without live model names", () => {
    expect(getProviderPresentation(mockConfig)).toEqual({
      provider: "Deterministic mock",
      researchModel: "deterministic-mock",
      nonWebModel: "deterministic-mock",
      workflowProvider: "Local",
    });
  });

  it("presents each lane as the model and effort the app is driven with", () => {
    const presentation = getProviderPresentation(desktopConfig);

    expect(presentation).toEqual({
      provider: "Local ChatGPT desktop app",
      researchModel: "GPT-5.6 Sol · High",
      nonWebModel: "GPT-5.6 Sol · Instant",
      workflowProvider: "Local",
      sourceProvenanceNote:
        "Web citations are model-declared: the desktop app reports neither its searches nor its token usage.",
    });
  });

  it("presents Trigger.dev when the resolved workflow provider is Trigger", () => {
    expect(getProviderPresentation(mockConfig, "trigger")).toMatchObject({
      workflowProvider: "Trigger.dev",
    });
  });
});

describe("resolveProviderPresentation", () => {
  it.each([
    {
      name: "an unknown provider",
      environment: { AI_PROVIDER: "openai", OPENAI_API_KEY: "must-not-leak" },
    },
    {
      name: "an out-of-range lane deadline",
      environment: {
        AI_PROVIDER: "chatgpt_desktop",
        AI_RESEARCH_TIMEOUT_MS: "999999",
      },
    },
    {
      name: "the desktop app with hosted Trigger workflows",
      environment: {
        AI_PROVIDER: "chatgpt_desktop",
        WORKFLOW_PROVIDER: "trigger",
      },
    },
    {
      name: "an unknown workflow provider",
      environment: { AI_PROVIDER: "mock", WORKFLOW_PROVIDER: "somewhere" },
    },
  ])("sanitizes $name", async ({ environment }) => {
    const presentation = await resolveProviderPresentation(environment);

    expect(presentation).toEqual({
      provider: "Misconfigured",
      researchModel: "Unavailable",
      nonWebModel: "Unavailable",
      workflowProvider: "Misconfigured",
      configurationNotice:
        "Provider configuration is invalid. Check the server environment.",
    });
    expect(JSON.stringify(presentation)).not.toContain("must-not-leak");
    expect(JSON.stringify(presentation)).not.toContain("999999");
  });

  it.each([
    [{}, "Local"],
    [{ WORKFLOW_PROVIDER: "mock" }, "Local"],
    [{ WORKFLOW_PROVIDER: "trigger" }, "Trigger.dev"],
  ] as const)(
    "uses the shared workflow resolver for %o",
    async (environment, workflowProvider) => {
      await expect(
        resolveProviderPresentation(environment),
      ).resolves.toMatchObject({ workflowProvider });
    },
  );

  it("rethrows unexpected resolver errors", async () => {
    const unexpected = new Error("unexpected failure");

    await expect(
      resolveProviderPresentation({}, () => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
  });

  it("never renders a secret that happens to sit in the environment", async () => {
    const presentation = await resolveProviderPresentation({
      AI_PROVIDER: "chatgpt_desktop",
      OPENAI_API_KEY: "must-not-leak",
      CHATGPT_DESKTOP_CDP_PORT: "9333",
    });

    expect(JSON.stringify(presentation)).not.toContain("must-not-leak");
    expect(presentation.provider).toBe("Local ChatGPT desktop app");
  });
});
