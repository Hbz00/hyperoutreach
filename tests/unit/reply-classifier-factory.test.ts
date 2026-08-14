import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createReplyClassifierFromBundle } =
  await import("@/modules/replies/classifier-factory");

describe("reply classifier provider routing", () => {
  it("uses the non-web lane on the same Codex provider used for research", async () => {
    const codexRun = vi.fn().mockResolvedValue({
      responseId: "codex-thread",
      model: "codex-cli:codex-fast",
      output: {
        category: "positive",
        confidence: 0.93,
        reason: "The sender wants to schedule a call.",
      },
      sources: [],
      usage: null,
      toolUsage: { webSearchCalls: 0 },
      costUsd: null,
      costAvailability: "unavailable",
    });
    const classifier = createReplyClassifierFromBundle({
      mode: "codex",
      usesRealInfrastructure: true,
      research: {
        provider: { run: codexRun },
        model: "codex-cli:codex-research",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: { run: codexRun },
        model: "codex-cli:codex-fast",
      },
    });

    expect(classifier.name).toBe("codex-cli-reply-v1");

    await expect(
      classifier.classify({
        subject: "Re: Introduction",
        body: "Yes, let's schedule a call.",
        sender: "ada@example.com",
      }),
    ).resolves.toMatchObject({ category: "positive" });
    expect(codexRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "reply_classifier",
        model: "codex-cli:codex-fast",
        useWebSearch: false,
      }),
    );
    expect(codexRun).toHaveBeenCalledTimes(1);
  });

  it("propagates Codex errors instead of invoking the research provider", async () => {
    const researchRun = vi.fn();
    const codexRun = vi.fn().mockRejectedValue(new Error("Codex unavailable"));
    const classifier = createReplyClassifierFromBundle({
      mode: "codex",
      usesRealInfrastructure: true,
      research: {
        provider: { run: researchRun },
        model: "research-model",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: { run: codexRun },
        model: "codex-cli:codex-fast",
      },
    });

    await expect(
      classifier.classify({
        subject: "Re",
        body: "Hello",
        sender: "ada@example.com",
      }),
    ).rejects.toThrow("Codex unavailable");
    expect(researchRun).not.toHaveBeenCalled();
  });

  it("uses the deterministic classifier in mock mode", async () => {
    const classifier = createReplyClassifierFromBundle({
      mode: "mock",
      usesRealInfrastructure: false,
    });

    expect(classifier.name).toBe("deterministic-local-v1");

    await expect(
      classifier.classify({
        subject: "Please unsubscribe",
        body: "Remove me",
        sender: "ada@example.com",
      }),
    ).resolves.toMatchObject({ category: "unsubscribe" });
  });

  it("preserves the OpenAI Responses classifier identity", () => {
    const responsesRun = vi.fn();
    const classifier = createReplyClassifierFromBundle({
      mode: "openai",
      usesRealInfrastructure: true,
      research: {
        provider: { run: responsesRun },
        model: "research-model",
        operationTimeoutMs: 30_000,
      },
      nonWeb: {
        provider: { run: responsesRun },
        model: "fast-model",
      },
    });

    expect(classifier.name).toBe("openai-responses-reply-v1");
  });
});
