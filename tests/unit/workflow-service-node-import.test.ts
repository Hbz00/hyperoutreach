import { describe, expect, it } from "vitest";

describe("workflow service Node runtime compatibility", () => {
  it("loads in a plain Trigger worker module graph without Next server-only shims", async () => {
    const workflowService = await import("@/modules/workflows/service-factory");

    expect(workflowService.createWorkflowTaskServices).toBeTypeOf("function");
  });
});
