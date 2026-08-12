import { describe, expect, it } from "vitest";

import { normalizeSuppressionTarget } from "@/modules/suppression/normalization";

describe("suppression normalization", () => {
  it("normalizes email and domain identities", () => {
    expect(normalizeSuppressionTarget("email", " Alice@BÜCHER.example ")).toBe(
      "alice@xn--bcher-kva.example",
    );
    expect(
      normalizeSuppressionTarget("domain", "https://WWW.BÜCHER.example/path"),
    ).toBe("xn--bcher-kva.example");
  });

  it("rejects an identity that does not match its scope", () => {
    expect(() => normalizeSuppressionTarget("email", "example.com")).toThrow();
    expect(() =>
      normalizeSuppressionTarget("domain", "a@example.com"),
    ).toThrow();
  });
});
