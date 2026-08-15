import { z } from "zod";

import type { StructuredResponseSource } from "@/lib/ai/providers/types";

/**
 * Web-capable providers answer with the business result and the URLs they
 * consulted in one object, because neither surface reports its retrieval as
 * structured tool output we could trust on its own. The envelope is what makes
 * a citation attributable to the turn that produced it.
 */
export const citationSchema = z
  .object({
    url: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "URL must use HTTP or HTTPS"),
    title: z.string().nullable(),
  })
  .strict();

export type Citation = z.infer<typeof citationSchema>;

export function webEnvelopeSchema<T>(outputSchema: z.ZodType<T>) {
  return z
    .object({
      output: outputSchema,
      sources: z.array(citationSchema),
    })
    .strict();
}

export function normalizeCitations(
  citations: Citation[],
): StructuredResponseSource[] {
  const byUrl = new Map<string, StructuredResponseSource>();
  for (const citation of citations) {
    const parsed = new URL(citation.url);
    parsed.hash = "";
    const url = parsed.toString();
    if (byUrl.has(url)) continue;
    byUrl.set(url, {
      url,
      ...(citation.title === null ? {} : { title: citation.title }),
      provenance: "model_declared_after_search",
    });
  }
  return [...byUrl.values()];
}

const JSON_SCHEMA_REGEX_LOOKAROUND = /\(\?(?:[=!]|<[=!])/;

/**
 * Zod emits constructs that model-facing schema consumers reject: `format:
 * "uri"` and lookaround in patterns. Dropping them keeps the schema advisory
 * where it cannot be enforced, while the Zod schema itself still validates the
 * answer once it comes back.
 */
export function portableJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableJsonSchema);
  if (typeof value !== "object" || value === null) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      portableJsonSchema(nested),
    ]),
  );
  if (normalized.format === "uri") delete normalized.format;
  if (
    typeof normalized.pattern === "string" &&
    JSON_SCHEMA_REGEX_LOOKAROUND.test(normalized.pattern)
  ) {
    delete normalized.pattern;
  }
  return normalized;
}
