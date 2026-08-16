import { describe, expect, it } from "vitest";

import {
  agentRunCost,
  agentRunDuration,
  agentRunLane,
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

// Both lanes run the same model on this transport. Without the effort the two
// are indistinguishable in the table, which is exactly the question you have
// when a run died on its deadline: did it have ten minutes, or two?
describe("which lane a run belonged to", () => {
  it("names the model and the effort together", () => {
    expect(agentRunLane("chatgpt-desktop:GPT-5.6 Sol", "High")).toBe(
      "chatgpt-desktop:GPT-5.6 Sol · High",
    );
    expect(agentRunLane("chatgpt-desktop:GPT-5.6 Sol", "Instant")).toBe(
      "chatgpt-desktop:GPT-5.6 Sol · Instant",
    );
  });

  it("distinguishes the two lanes, which is the whole point", () => {
    const model = "chatgpt-desktop:GPT-5.6 Sol";
    expect(agentRunLane(model, "High")).not.toBe(
      agentRunLane(model, "Instant"),
    );
  });

  // A mock has no lane, and a row written before the column existed has no
  // answer. Neither gets an invented one.
  it("falls back to the model alone when no effort was recorded", () => {
    expect(agentRunLane("mock-model", null)).toBe("mock-model");
  });
});
