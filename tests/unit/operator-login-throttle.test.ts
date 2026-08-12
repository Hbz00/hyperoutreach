import { describe, expect, it } from "vitest";

import { OperatorLoginThrottle } from "@/lib/operator-login-throttle";

describe("operator login throttle", () => {
  it("blocks a source after bounded failures and clears it after the window", () => {
    const throttle = new OperatorLoginThrottle({ limit: 3, windowMs: 60_000 });
    const start = new Date("2026-08-12T10:00:00.000Z");
    expect(throttle.check("203.0.113.10", start)).toEqual({ allowed: true });
    throttle.recordFailure("203.0.113.10", start);
    throttle.recordFailure("203.0.113.10", start);
    throttle.recordFailure("203.0.113.10", start);
    expect(throttle.check("203.0.113.10", start)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(
      throttle.check("203.0.113.10", new Date(start.getTime() + 60_001)),
    ).toEqual({ allowed: true });
  });

  it("resets failures after a successful login", () => {
    const throttle = new OperatorLoginThrottle({ limit: 1, windowMs: 60_000 });
    const now = new Date();
    throttle.recordFailure("local", now);
    throttle.recordSuccess("local");
    expect(throttle.check("local", now)).toEqual({ allowed: true });
  });
});
