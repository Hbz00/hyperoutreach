const supportedVariables = new Set([
  "first_name",
  "last_name",
  "company",
  "job_title",
] as const);

export type InterpolationValues = Record<
  "first_name" | "last_name" | "company" | "job_title",
  string | null | undefined
>;

export type InterpolationError =
  | { ok: false; code: "MALFORMED_TEMPLATE" }
  | {
      ok: false;
      code: "UNKNOWN_VARIABLE" | "MISSING_VARIABLE";
      variable: string;
    };

export function interpolateStrict(
  template: string,
  values: InterpolationValues,
): string | InterpolationError {
  const withoutVariables = template.replace(/{{\s*[^{}]+\s*}}/g, "");
  if (withoutVariables.includes("{{") || withoutVariables.includes("}}")) {
    return { ok: false, code: "MALFORMED_TEMPLATE" };
  }

  let failure: InterpolationError | undefined;
  const output = template.replace(/{{\s*([^{}]+?)\s*}}/g, (_, raw: string) => {
    const variable = raw.trim();
    if (!supportedVariables.has(variable as never)) {
      failure = { ok: false, code: "UNKNOWN_VARIABLE", variable };
      return "";
    }
    const value = values[variable as keyof InterpolationValues];
    if (typeof value !== "string" || !value.trim()) {
      failure = { ok: false, code: "MISSING_VARIABLE", variable };
      return "";
    }
    return value;
  });

  return failure ?? output;
}
