import { zodTextFormat } from "openai/helpers/zod";

import type {
  StructuredResponseSource,
  StructuredResponseRequest,
  StructuredResponseResult,
} from "@/lib/openai/providers/types";

export type {
  StructuredResponseRequest,
  StructuredResponseResult,
} from "@/lib/openai/providers/types";

export type ResponsesClient = {
  responses: {
    parse(
      request: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
};

export class OpenAIRefusalError extends Error {
  override readonly name = "OpenAIRefusalError";
}

export class OpenAIOutputValidationError extends Error {
  override readonly name = "OpenAIOutputValidationError";
}

export class OpenAIProviderError extends Error {
  override readonly name = "OpenAIProviderError";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function outputItems(response: Record<string, unknown>): unknown[] {
  return Array.isArray(response.output) ? response.output : [];
}

function hasRefusal(response: Record<string, unknown>): boolean {
  return outputItems(response).some((item) => {
    const output = record(item);
    return (
      output?.type === "message" &&
      Array.isArray(output.content) &&
      output.content.some((content) => record(content)?.type === "refusal")
    );
  });
}

function extractSources(
  response: Record<string, unknown>,
): StructuredResponseSource[] {
  const byUrl = new Map<string, StructuredResponseSource>();
  for (const item of outputItems(response)) {
    const output = record(item);
    if (!output) continue;
    const action = record(output.action);
    if (output.type === "web_search_call" && Array.isArray(action?.sources)) {
      for (const source of action.sources) {
        const candidate = record(source);
        if (typeof candidate?.url === "string") {
          byUrl.set(candidate.url, {
            url: candidate.url,
            ...(typeof candidate.title === "string"
              ? { title: candidate.title }
              : {}),
            provenance: "tool_observed",
          });
        }
      }
    }
  }
  return [...byUrl.values()];
}

function extractUsage(response: Record<string, unknown>) {
  const usage = record(response.usage);
  if (
    typeof usage?.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number" ||
    typeof usage.total_tokens !== "number"
  ) {
    return null;
  }
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(typeof inputDetails?.cached_tokens === "number"
      ? { cachedInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof inputDetails?.cache_write_tokens === "number"
      ? { cacheWriteInputTokens: inputDetails.cache_write_tokens }
      : {}),
    ...(typeof outputDetails?.reasoning_tokens === "number"
      ? { reasoningTokens: outputDetails.reasoning_tokens }
      : {}),
  };
}

export class OpenAIResponsesProvider {
  constructor(
    private readonly client: ResponsesClient,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  async run<T>(
    request: StructuredResponseRequest<T>,
  ): Promise<StructuredResponseResult<T>> {
    let rawResponse: unknown;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("OpenAI request timed out")),
      this.options.timeoutMs ?? 30_000,
    );
    try {
      rawResponse = await this.client.responses.parse(
        {
          model: request.model,
          instructions: request.instructions,
          input: JSON.stringify(request.input),
          ...(request.useWebSearch
            ? {
                tools: [{ type: "web_search" }],
                include: ["web_search_call.action.sources"],
              }
            : {}),
          text: {
            format: zodTextFormat(request.outputSchema, request.outputName),
          },
          metadata: { agent: request.agent },
          store: false,
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (
        error instanceof OpenAIRefusalError ||
        error instanceof OpenAIOutputValidationError
      ) {
        throw error;
      }
      throw new OpenAIProviderError("OpenAI request failed", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const response = record(rawResponse);
    if (!response) {
      throw new OpenAIOutputValidationError(
        "OpenAI returned an invalid response envelope",
      );
    }
    if (hasRefusal(response)) {
      throw new OpenAIRefusalError("The model refused the structured request");
    }

    const parsed = request.outputSchema.safeParse(response.output_parsed);
    if (!parsed.success) {
      throw new OpenAIOutputValidationError(
        "OpenAI returned invalid structured output",
        { cause: parsed.error },
      );
    }
    if (typeof response.id !== "string" || typeof response.model !== "string") {
      throw new OpenAIOutputValidationError(
        "OpenAI response metadata was incomplete",
      );
    }

    return {
      responseId: response.id,
      model: response.model,
      output: parsed.data,
      sources: extractSources(response),
      usage: extractUsage(response),
      toolUsage: {
        webSearchCalls: outputItems(response).filter(
          (item) => record(item)?.type === "web_search_call",
        ).length,
      },
      costUsd: null,
      costAvailability: "unavailable",
    };
  }
}
