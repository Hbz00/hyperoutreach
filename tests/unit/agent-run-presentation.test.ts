import { describe, expect, it } from "vitest";

import {
  agentRunCost,
  agentRunDuration,
} from "@/modules/settings/agent-run-presentation";

describe("agent run presentation", () => {
  it("reports how long a finished run took", () => {
    expect(
      agentRunDuration(
        new Date("2026-08-16T12:00:00.000Z"),
        new Date("2026-08-16T12:02:18.000Z"),
      ),
    ).toBe("138 s");
  });

  it("says a run is still going rather than inventing a duration", () => {
    expect(agentRunDuration(new Date("2026-08-16T12:00:00.000Z"), null)).toBe(
      "running",
    );
  });

  // The desktop transport reports no token usage and no cost. A zero here
  // would read as "this was free", which is a different claim from "this
  // surface cannot tell us".
  it("never turns an unavailable cost into a number", () => {
    expect(agentRunCost("unavailable", null)).toBe("unavailable");
    expect(agentRunCost("unavailable", "0.000000")).toBe("unavailable");
    expect(agentRunCost(null, null)).toBe("unavailable");
  });

  it("shows a cost the provider actually reported", () => {
    expect(agentRunCost("available", "0.014200")).toBe("$0.0142");
  });

  it("does not claim a cost is available without a figure", () => {
    expect(agentRunCost("available", null)).toBe("unavailable");
  });
});
