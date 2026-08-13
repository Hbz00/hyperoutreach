import { describe, expect, it, vi } from "vitest";

import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";

function writerDouble() {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const writer = {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return { returning: async () => [{ id: "run-id" }] };
      },
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    })),
  };
  return { writer, inserts, updates };
}

const codexAgent = {
  name: "personalization",
  model: "codex-cli:gpt-5.6-luna",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
};

describe("Codex model observability", () => {
  it("persists the Codex model prefix for successful runs", async () => {
    const { writer, inserts, updates } = writerDouble();
    const runId = await startAgentRun(writer as never, codexAgent, {
      input: true,
    });
    await completeAgentRun(writer as never, runId, {
      responseId: "codex-thread",
      model: "codex-cli:gpt-5.6-luna",
      output: { ok: true },
      sources: [],
      usage: null,
      toolUsage: { webSearchCalls: 0 },
      costUsd: null,
      costAvailability: "unavailable",
    });

    expect(inserts[0]?.model).toBe("codex-cli:gpt-5.6-luna");
    expect(updates[0]).toMatchObject({
      status: "succeeded",
      model: "codex-cli:gpt-5.6-luna",
    });
  });

  it("preserves live source provenance when completing a run", async () => {
    const { writer, updates } = writerDouble();

    await completeAgentRun(writer as never, "run-id", {
      responseId: "codex-thread",
      model: "codex-cli:gpt-5.6-luna",
      output: { ok: true },
      sources: [
        {
          url: "https://example.com/source",
          title: "Example",
          provenance: "model_declared_after_search",
        },
      ],
      usage: null,
      toolUsage: { webSearchCalls: 1 },
      costUsd: null,
      costAvailability: "unavailable",
    });

    expect(updates[0]?.sources).toEqual([
      {
        url: "https://example.com/source",
        title: "Example",
        provenance: "model_declared_after_search",
      },
    ]);
  });

  it("retains the prefixed start model when a Codex run fails", async () => {
    const { writer, inserts, updates } = writerDouble();
    const runId = await startAgentRun(writer as never, codexAgent, {
      input: true,
    });
    await failAgentRun(writer as never, runId, new Error("Codex failed"));

    expect(inserts[0]?.model).toBe("codex-cli:gpt-5.6-luna");
    expect(updates[0]).toMatchObject({
      status: "failed",
      error: "Agent execution failed (Error)",
    });
    expect(updates[0]).not.toHaveProperty("model");
  });
});
