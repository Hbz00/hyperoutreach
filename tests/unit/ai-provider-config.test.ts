import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  AIProviderConfigurationError,
  MAX_AI_TIMEOUT_MS,
  resolveAIProviderConfig,
  type AIProviderMode,
  type ResolvedAIProviderConfig,
} from "@/lib/ai/provider-config";
import {
  createLiveAIProviderBundle,
  type AIProviderBundle,
} from "@/lib/ai/provider-bundle";
import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import type { StructuredAIProvider } from "@/lib/ai/providers/types";

function providerDouble(label: string): StructuredAIProvider {
  return {
    run: vi.fn(async () => {
      throw new Error(`${label} should not run in a bundle construction test`);
    }),
  };
}

const desktopDefaults = {
  research: { model: "GPT-5.6 Sol", effort: "High", timeoutMs: 600_000 },
  fast: { model: "GPT-5.6 Sol", effort: "Instant", timeoutMs: 120_000 },
};

describe("AI provider configuration", () => {
  it("stays on mocks until the live surface is asked for by name", () => {
    // The live surface launches and drives the operator's own ChatGPT app, so
    // it is never what an unconfigured environment gets.
    const config: ResolvedAIProviderConfig = resolveAIProviderConfig({});

    expect(config).toEqual({ mode: "mock", usesRealInfrastructure: false });
    expect(resolveAIProviderConfig({ AI_PROVIDER: " mock " })).toEqual(config);

    const live: AIProviderMode = "chatgpt_desktop";
    expect(
      resolveAIProviderConfig({ AI_PROVIDER: " chatgpt_desktop " }),
    ).toEqual({
      mode: live,
      usesRealInfrastructure: true,
      chatGptDesktop: desktopDefaults,
    });
  });

  it("gives research a deep lane and the fast path an instant one", () => {
    const config = resolveAIProviderConfig({ AI_PROVIDER: "chatgpt_desktop" });
    if (config.mode !== "chatgpt_desktop") throw new Error("unexpected mode");

    expect(config.chatGptDesktop.research.effort).toBe("High");
    expect(config.chatGptDesktop.fast.effort).toBe("Instant");
    expect(config.chatGptDesktop.research.timeoutMs).toBeGreaterThan(
      config.chatGptDesktop.fast.timeoutMs,
    );
  });

  it("accepts explicit lane settings and trims them", () => {
    expect(
      resolveAIProviderConfig({
        AI_PROVIDER: "chatgpt_desktop",
        AI_RESEARCH_MODEL: " GPT-5.5 ",
        AI_RESEARCH_EFFORT: " Medium ",
        AI_RESEARCH_TIMEOUT_MS: "900000",
        AI_FAST_MODEL: "GPT-5.6 Sol",
        AI_FAST_EFFORT: "Medium",
        AI_FAST_TIMEOUT_MS: "60000",
      }),
    ).toEqual({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      chatGptDesktop: {
        research: { model: "GPT-5.5", effort: "Medium", timeoutMs: 900_000 },
        fast: { model: "GPT-5.6 Sol", effort: "Medium", timeoutMs: 60_000 },
      },
    });
  });

  it("rejects an unknown provider mode instead of silently selecting mocks", () => {
    expect(() =>
      resolveAIProviderConfig({ AI_PROVIDER: "openai" }),
    ).toThrowError(AIProviderConfigurationError);
  });

  it.each([
    ["AI_RESEARCH_TIMEOUT_MS", "0"],
    ["AI_RESEARCH_TIMEOUT_MS", "900001"],
    ["AI_RESEARCH_TIMEOUT_MS", "1.5"],
    ["AI_FAST_TIMEOUT_MS", "not-a-number"],
  ])("rejects invalid bounded integer %s=%s", (key, value) => {
    expect(() =>
      resolveAIProviderConfig({ AI_PROVIDER: "chatgpt_desktop", [key]: value }),
    ).toThrowError(AIProviderConfigurationError);
  });

  it("rejects a picker label that could not come from the app", () => {
    expect(() =>
      resolveAIProviderConfig({
        AI_PROVIDER: "chatgpt_desktop",
        AI_RESEARCH_MODEL: "x".repeat(121),
      }),
    ).toThrowError(AIProviderConfigurationError);
  });

  it("refuses hosted workflow execution, which has no desktop app to drive", () => {
    expect(() =>
      resolveAIProviderConfig({
        AI_PROVIDER: "chatgpt_desktop",
        WORKFLOW_PROVIDER: " trigger ",
      }),
    ).toThrowError(/local workflow execution/i);
    expect(() =>
      resolveAIProviderConfig({ WORKFLOW_PROVIDER: "trigger" }),
    ).not.toThrow();
  });

  it.each([undefined, "", "local", "mock"])(
    "allows local workflow execution (%s)",
    (workflowProvider) => {
      expect(
        resolveAIProviderConfig({
          AI_PROVIDER: "chatgpt_desktop",
          WORKFLOW_PROVIDER: workflowProvider,
        }),
      ).toMatchObject({ mode: "chatgpt_desktop" });
    },
  );

  // The AI-sized ceiling moved with the AI. Operator commands that would take
  // a turn are queued and drained by the maintenance cycle, so the request no
  // longer has to outlive a ten-minute research call — and the maintenance
  // route now has to.
  it("keeps the maintenance route alive for the slowest allowed AI call", () => {
    const routeSource = readFileSync(
      "src/app/api/internal/workflows/reconcile/route.ts",
      "utf8",
    );
    const literal = routeSource.match(/export const maxDuration = (\d+);/)?.[1];

    expect(literal).toBeDefined();
    expect(Number(literal) * 1_000).toBeGreaterThanOrEqual(MAX_AI_TIMEOUT_MS);
  });

  it("no longer sizes the operator command route for an AI call", () => {
    const routeSource = readFileSync(
      "src/app/api/operator/commands/[command]/route.ts",
      "utf8",
    );
    const literal = routeSource.match(/export const maxDuration = (\d+);/)?.[1];

    expect(literal).toBeDefined();
    expect(Number(literal) * 1_000).toBeLessThan(MAX_AI_TIMEOUT_MS);
  });
});

describe("AI provider bundle", () => {
  it("keeps mock mode free of any provider construction", () => {
    const chatGptDesktop = vi.fn();

    expect(createProductionAIProviderBundle({}, { chatGptDesktop })).toEqual({
      mode: "mock",
      usesRealInfrastructure: false,
    });
    expect(chatGptDesktop).not.toHaveBeenCalled();
  });

  it("shares one desktop provider between both lanes", () => {
    const desktop = providerDouble("desktop");
    const factory = vi.fn(() => desktop);
    const config = resolveAIProviderConfig({
      AI_PROVIDER: "chatgpt_desktop",
      AI_RESEARCH_MODEL: "GPT-5.6 Sol",
      AI_FAST_MODEL: "GPT-5.5",
    });
    if (config.mode !== "chatgpt_desktop") throw new Error("unexpected mode");

    const bundle: AIProviderBundle = createLiveAIProviderBundle(config, {
      chatGptDesktop: factory,
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(config.chatGptDesktop);
    // One provider, two lanes — and each lane carries the effort that makes it
    // a lane. The models can be identical, as they are with the shipped
    // configuration; the effort is what tells a ten-minute web-capable turn
    // from a two-minute one, all the way down to the audit row.
    expect(bundle).toEqual({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: desktop,
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "High",
        operationTimeoutMs: 600_000,
      },
      nonWeb: {
        provider: desktop,
        model: "chatgpt-desktop:GPT-5.5",
        effort: "Instant",
      },
    });
  });

  it("fails closed without a provider factory", () => {
    const config = resolveAIProviderConfig({ AI_PROVIDER: "chatgpt_desktop" });
    if (config.mode !== "chatgpt_desktop") throw new Error("unexpected mode");

    expect(() => createLiveAIProviderBundle(config, {})).toThrowError(
      AIProviderConfigurationError,
    );
  });

  it("builds a real desktop provider in production wiring", () => {
    const bundle = createProductionAIProviderBundle({
      AI_PROVIDER: "chatgpt_desktop",
    });

    if (bundle.mode === "mock") throw new Error("unexpected mock bundle");
    expect(bundle.research.provider).toBe(bundle.nonWeb.provider);
    expect(bundle.research.model).toBe("chatgpt-desktop:GPT-5.6 Sol");
  });
});
