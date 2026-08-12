import { describe, expect, it } from "vitest";

import { interpolateStrict } from "@/modules/messages/interpolation";

describe("strict outreach interpolation", () => {
  const values = {
    first_name: "Alice",
    last_name: "Martin",
    company: "Acme",
    job_title: "VP Sales",
  };

  it("interpolates only the supported deterministic variables", () => {
    expect(
      interpolateStrict(
        "Hello {{first_name}} {{last_name}} at {{company}} ({{job_title}})",
        values,
      ),
    ).toBe("Hello Alice Martin at Acme (VP Sales)");
  });

  it("rejects an unknown variable", () => {
    expect(interpolateStrict("Hello {{nickname}}", values)).toEqual({
      ok: false,
      code: "UNKNOWN_VARIABLE",
      variable: "nickname",
    });
  });

  it("rejects a supported variable whose value is missing", () => {
    expect(
      interpolateStrict("Role: {{job_title}}", {
        ...values,
        job_title: null,
      }),
    ).toEqual({
      ok: false,
      code: "MISSING_VARIABLE",
      variable: "job_title",
    });
  });

  it("rejects malformed template delimiters", () => {
    expect(interpolateStrict("Hello {{first_name", values)).toEqual({
      ok: false,
      code: "MALFORMED_TEMPLATE",
    });
  });
});
