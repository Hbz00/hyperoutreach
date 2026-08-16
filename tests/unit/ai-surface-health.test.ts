import { describe, expect, it, vi } from "vitest";

import { probeAiSurface } from "@/modules/settings/ai-surface-health";

describe("AI surface health", () => {
  it("has nothing to reach in mock mode, and does not probe", async () => {
    const probePort = vi.fn(async () => true);

    const health = await probeAiSurface({
      environment: { AI_PROVIDER: "mock" },
      probePort,
    });

    expect(health).toMatchObject({ mode: "mock", reachable: null });
    expect(probePort).not.toHaveBeenCalled();
  });

  it("reports the desktop app as reachable on its configured port", async () => {
    const health = await probeAiSurface({
      environment: {
        AI_PROVIDER: "chatgpt_desktop",
        CHATGPT_DESKTOP_CDP_PORT: "9444",
      },
      probePort: async (port) => port === 9444,
    });

    expect(health).toMatchObject({ mode: "chatgpt_desktop", reachable: true });
    expect(health.detail).toContain("9444");
  });

  it("says how to fix an unreachable app instead of only that it is down", async () => {
    const health = await probeAiSurface({
      environment: { AI_PROVIDER: "chatgpt_desktop" },
      probePort: async () => false,
    });

    expect(health.reachable).toBe(false);
    expect(health.detail).toContain("remote-debugging-port");
  });

  // A misconfiguration must read as a misconfiguration, not as an outage.
  it("reports a configuration error without probing", async () => {
    const probePort = vi.fn(async () => true);

    const health = await probeAiSurface({
      environment: { AI_PROVIDER: "nonsense" },
      probePort,
    });

    expect(health.reachable).toBeNull();
    expect(health.detail).toContain("AI_PROVIDER");
    expect(probePort).not.toHaveBeenCalled();
  });
});
