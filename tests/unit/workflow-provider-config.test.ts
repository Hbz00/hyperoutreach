import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AIProviderConfigurationError } from "@/lib/openai/provider-config";
import {
  WorkflowProviderConfigurationError,
  resolveWorkflowProvider,
} from "@/modules/workflows/provider-config";

describe("workflow provider configuration", () => {
  it.each([
    [{}, "local"],
    [{ WORKFLOW_PROVIDER: "" }, "local"],
    [{ WORKFLOW_PROVIDER: " local " }, "local"],
    [{ WORKFLOW_PROVIDER: " mock " }, "local"],
    [{ WORKFLOW_PROVIDER: " trigger " }, "trigger"],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(resolveWorkflowProvider(environment)).toBe(expected);
  });

  it("rejects unknown workflow providers", () => {
    expect(() =>
      resolveWorkflowProvider({ WORKFLOW_PROVIDER: " local-ish " }),
    ).toThrowError(WorkflowProviderConfigurationError);
  });

  it("makes the dispatcher reject unknown values before selecting local", async () => {
    const { createWorkflowDispatcher } =
      await import("@/modules/workflows/dispatcher-factory");

    expect(() =>
      createWorkflowDispatcher({ WORKFLOW_PROVIDER: "local-ish" }),
    ).toThrowError(WorkflowProviderConfigurationError);
  });

  it("makes the dispatcher recognize a trimmed Trigger value", async () => {
    const { createWorkflowDispatcher } =
      await import("@/modules/workflows/dispatcher-factory");

    expect(() =>
      createWorkflowDispatcher({ WORKFLOW_PROVIDER: " trigger " }),
    ).toThrowError(/TRIGGER_SECRET_KEY is required/);
  });

  it("rejects Codex in Trigger before constructing the dispatcher", async () => {
    const { createWorkflowDispatcher } =
      await import("@/modules/workflows/dispatcher-factory");

    expect(() =>
      createWorkflowDispatcher({
        WORKFLOW_PROVIDER: "trigger",
        TRIGGER_SECRET_KEY: "trigger-secret",
        OPENAI_PROVIDER: "codex",
      }),
    ).toThrowError(AIProviderConfigurationError);
  });
});
