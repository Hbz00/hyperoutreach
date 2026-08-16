import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createReplyClassifierFromBundle } =
  await import("@/modules/replies/classifier-factory");

describe("reply classifier provider routing", () => {
  it("uses the non-web lane on the same surface as research", async () => {
    const desktopRun = vi.fn().mockResolvedValue({
      responseId: "chatgpt-desktop_test",
      model: "chatgpt-desktop:GPT-5.6 Sol",
      output: {
        category: "positive",
        confidence: 0.93,
        reason: "The sender wants to schedule a call.",
      },
      sources: [],
      usage: null,
      toolUsage: null,
      costUsd: null,
      costAvailability: "unavailable",
    });
    const classifier = createReplyClassifierFromBundle({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: { run: desktopRun },
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "High",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: { run: desktopRun },
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "Instant",
      },
    });

    expect(classifier.name).toBe("chatgpt-desktop-reply-v1");

    await expect(
      classifier.classify({
        subject: "Re: Introduction",
        body: "Yes, let's schedule a call.",
        sender: "ada@example.com",
      }),
    ).resolves.toMatchObject({ category: "positive" });
    expect(desktopRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "reply_classifier",
        model: "chatgpt-desktop:GPT-5.6 Sol",
        useWebSearch: false,
      }),
    );
    expect(desktopRun).toHaveBeenCalledTimes(1);
  });

  it("propagates surface errors instead of invoking the research lane", async () => {
    const researchRun = vi.fn();
    const desktopRun = vi
      .fn()
      .mockRejectedValue(new Error("ChatGPT desktop is not reachable"));
    const classifier = createReplyClassifierFromBundle({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: { run: researchRun },
        model: "research-model",
        effort: "High",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: { run: desktopRun },
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "Instant",
      },
    });

    await expect(
      classifier.classify({
        subject: "Re",
        body: "Hello",
        sender: "ada@example.com",
      }),
    ).rejects.toThrow("ChatGPT desktop is not reachable");
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

  it("names the classifier after the surface that answered", () => {
    const run = vi.fn();
    const classifier = createReplyClassifierFromBundle({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: { run },
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "High",
        operationTimeoutMs: 600_000,
      },
      nonWeb: {
        provider: { run },
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "Instant",
      },
    });

    expect(classifier.name).toBe("chatgpt-desktop-reply-v1");
    expect(run).not.toHaveBeenCalled();
  });
});
