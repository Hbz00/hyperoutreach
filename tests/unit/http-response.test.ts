import { describe, expect, it } from "vitest";

import { mutableRedirect } from "@/lib/http-response";

describe("mutableRedirect", () => {
  it("creates a redirect whose headers can be extended with a clearing cookie", () => {
    const response = mutableRedirect(
      "http://localhost:3000/settings?microsoft=connected",
      303,
    );

    expect(() =>
      response.headers.append("Set-Cookie", "oauth_binding=; Max-Age=0"),
    ).not.toThrow();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/settings?microsoft=connected",
    );
  });
});
