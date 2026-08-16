/**
 * The deterministic fields, resolved from the prospect record.
 */
const contactVariables = [
  "first_name",
  "last_name",
  "company",
  "job_title",
] as const;

/**
 * The two fields an agent may write, declared per sequence step. They are in
 * the same whitelist as the deterministic ones and resolved the same way: a
 * template can only name what the caller supplies, so a step that asks for a
 * sentence the agent did not produce fails to interpolate rather than sending
 * a gap.
 */
const reasoningVariables = [
  "company_relevance",
  "personalized_opening",
] as const;

const supportedVariables = new Set<string>([
  ...contactVariables,
  ...reasoningVariables,
]);

export type ContactVariable = (typeof contactVariables)[number];
export type ReasoningVariable = (typeof reasoningVariables)[number];

export const REASONING_VARIABLES = reasoningVariables;

export type InterpolationValues = Record<
  ContactVariable,
  string | null | undefined
> &
  Partial<Record<ReasoningVariable, string | null | undefined>>;

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
    if (!supportedVariables.has(variable)) {
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

/** Which agent-written fields a template actually uses. */
export function reasoningVariablesUsed(
  ...templates: string[]
): ReasoningVariable[] {
  const used = new Set<ReasoningVariable>();
  for (const template of templates) {
    for (const match of template.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
      const variable = match[1]?.trim();
      if (
        variable &&
        (reasoningVariables as readonly string[]).includes(variable)
      ) {
        used.add(variable as ReasoningVariable);
      }
    }
  }
  return [...used];
}
