import { describe, expect, it } from "vitest";

import {
  normalizeDomain,
  normalizeEmail,
} from "@/modules/prospects/normalization";
import { normalizeSuppressionTarget } from "@/modules/suppression/normalization";

describe("email address normalization boundaries", () => {
  it.each([
    [" Alice.Doe@Example.COM ", "alice.doe@example.com"],
    ["Alice@www.example.com", "alice@www.example.com"],
    ["Alice@www.www.example.com", "alice@www.www.example.com"],
    ["Alice@BÜCHER.example", "alice@xn--bcher-kva.example"],
    ["a+b@dept.example.com", "a+b@dept.example.com"],
    [
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    ],
  ])("normalizes the complete mailbox %s", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([
    "alice@example.com/path",
    "alice@example.com/",
    "alice@example.com?query=1",
    "alice@example.com#fragment",
    "alice@https://example.com",
    "alice@example.com:443",
    "alice@example.com:80",
    "alice@example.com\\path",
    "alice@%65xample.com",
    "alice@example.com\u0000",
    "alice@example.com\u0001",
    "alice@user:pass@example.com",
    "alice@@example.com",
    "alice@example..com",
    "alice@-example.com",
    "alice@example-.com",
    "alice@example.com.",
    "alice@localhost",
    "alice@",
    "@example.com",
    "alice..smith@example.com",
    ".alice@example.com",
    "alice.@example.com",
    `${"a".repeat(65)}@example.com`,
    `alice@${"a".repeat(64)}.com`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("refuses the entire malformed mailbox %s", (input) => {
    expect(() => normalizeEmail(input)).toThrow("Invalid email");
  });

  it("keeps email suppressions distinct across the www subdomain", () => {
    expect(normalizeSuppressionTarget("email", "Alice@www.Example.com")).toBe(
      "alice@www.example.com",
    );
    expect(
      normalizeSuppressionTarget("email", "Alice@www.Example.com"),
    ).not.toBe(normalizeSuppressionTarget("email", "Alice@Example.com"));
  });

  it("retains URL normalization for company domains", () => {
    expect(normalizeDomain("https://www.Example.com/about?query=1")).toBe(
      "example.com",
    );
  });
});
