import { describe, expect, it } from "vitest";

import { isCurrentPath } from "@/app/(operator)/nav-links";

// Which link is highlighted. A bare prefix match is the easy mistake here, and
// it is invisible in review because the wrong answer only shows up on a route
// that does not exist yet.
describe("the highlighted navigation link", () => {
  it("marks the page you are on", () => {
    expect(isCurrentPath("/review", "/review")).toBe(true);
  });

  it("marks the parent of a page nested under it", () => {
    expect(isCurrentPath("/prospects", "/prospects/abc-123")).toBe(true);
  });

  // The reason the match is on a boundary. `/reviews` is not under `/review`,
  // and highlighting it there would make a different page look current.
  it("does not mark a sibling that merely starts with the same letters", () => {
    expect(isCurrentPath("/review", "/reviews")).toBe(false);
    expect(isCurrentPath("/campaigns", "/campaigns-archive")).toBe(false);
  });

  // Every path starts with "/", so root is the one link that has to be exact.
  it("marks the dashboard only on the dashboard", () => {
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/", "/review")).toBe(false);
  });
});
