import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { requireOpenAIConfig } from "@/lib/openai/config";
import {
  OpenAIOutputValidationError,
  OpenAIProviderError,
  OpenAIRefusalError,
  OpenAIResponsesProvider,
  type ResponsesClient,
} from "@/lib/openai/providers/responses-provider";

const outputSchema = z.object({
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test",
    model: "gpt-5.6-terra",
    output_parsed: { answer: "Evidence-backed", confidence: 0.91 },
    output: [
      {
        type: "web_search_call",
        action: {
          type: "search",
          sources: [{ type: "url", url: "https://example.com/source" }],
        },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "structured",
            parsed: { answer: "Evidence-backed", confidence: 0.91 },
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/citation",
                title: "Citation",
                start_index: 0,
                end_index: 10,
              },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: {
        cached_tokens: 40,
        cache_write_tokens: 10,
      },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 7 },
      total_tokens: 125,
    },
    ...overrides,
  };
}

describe("OpenAI Responses structured-output boundary", () => {
  it("uses Responses API web_search and a strict schema while extracting usage and sources", async () => {
    const parse = vi.fn().mockResolvedValue(response());
    const provider = new OpenAIResponsesProvider({
      responses: { parse },
    } as ResponsesClient);

    const result = await provider.run({
      agent: "account_research",
      model: "gpt-5.6-terra",
      instructions: "Return evidence-backed facts only.",
      input: { account: { name: "Acme", domain: "acme.example" } },
      outputSchema,
      outputName: "account_research_v1",
      useWebSearch: true,
    });

    expect(parse).toHaveBeenCalledOnce();
    const request = parse.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "gpt-5.6-terra",
      instructions: "Return evidence-backed facts only.",
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "account_research_v1",
          strict: true,
        },
      },
    });
    expect(JSON.parse(request.input)).toEqual({
      account: { name: "Acme", domain: "acme.example" },
    });
    expect(result).toEqual({
      responseId: "resp_test",
      model: "gpt-5.6-terra",
      output: { answer: "Evidence-backed", confidence: 0.91 },
      sources: [
        {
          url: "https://example.com/source",
          provenance: "tool_observed",
        },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        reasoningTokens: 7,
      },
      toolUsage: { webSearchCalls: 1 },
      costUsd: null,
      costAvailability: "unavailable",
    });
  });

  it("aborts a hung Responses request at the configured deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const provider = new OpenAIResponsesProvider(
      {
        responses: {
          parse: vi.fn(async (_request, options) => {
            observedSignal = options?.signal;
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal?.reason),
                { once: true },
              );
            });
          }),
        },
      } as ResponsesClient,
      { timeoutMs: 20 },
    );
    await expect(
      provider.run({
        agent: "test",
        model: "gpt-5.6-luna",
        instructions: "Test",
        input: {},
        outputSchema,
        outputName: "test_v1",
        useWebSearch: false,
      }),
    ).rejects.toBeInstanceOf(OpenAIProviderError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not treat model citation annotations as actual web-search sources", async () => {
    const provider = new OpenAIResponsesProvider({
      responses: {
        parse: vi.fn().mockResolvedValue(
          response({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://model.example/unsupported",
                        title: "Unsupported",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      },
    } as ResponsesClient);
    const observed = await provider.run({
      agent: "test",
      model: "gpt-5.6-terra",
      instructions: "Test",
      input: {},
      outputSchema,
      outputName: "test_v1",
      useWebSearch: true,
    });
    expect(observed.sources).toEqual([]);
  });

  it("rejects provider output that does not satisfy the Zod schema", async () => {
    const provider = new OpenAIResponsesProvider({
      responses: {
        parse: vi
          .fn()
          .mockResolvedValue(
            response({ output_parsed: { answer: "", confidence: 4 } }),
          ),
      },
    } as ResponsesClient);

    await expect(
      provider.run({
        agent: "test",
        model: "gpt-5.6-luna",
        instructions: "Test",
        input: {},
        outputSchema,
        outputName: "test_v1",
        useWebSearch: false,
      }),
    ).rejects.toBeInstanceOf(OpenAIOutputValidationError);
  });

  it("surfaces model refusals as a typed error", async () => {
    const provider = new OpenAIResponsesProvider({
      responses: {
        parse: vi.fn().mockResolvedValue(
          response({
            output_parsed: null,
            output: [
              {
                type: "message",
                content: [{ type: "refusal", refusal: "Cannot comply" }],
              },
            ],
          }),
        ),
      },
    } as ResponsesClient);

    await expect(
      provider.run({
        agent: "test",
        model: "gpt-5.6-luna",
        instructions: "Test",
        input: {},
        outputSchema,
        outputName: "test_v1",
        useWebSearch: false,
      }),
    ).rejects.toMatchObject({
      name: "OpenAIRefusalError",
      message: "The model refused the structured request",
    } satisfies Partial<OpenAIRefusalError>);
  });

  it("sanitizes provider errors without leaking API keys", async () => {
    const provider = new OpenAIResponsesProvider({
      responses: {
        parse: vi
          .fn()
          .mockRejectedValue(new Error("request failed sk-secret-value")),
      },
    } as ResponsesClient);

    const operation = provider.run({
      agent: "test",
      model: "gpt-5.6-luna",
      instructions: "Test",
      input: {},
      outputSchema,
      outputName: "test_v1",
      useWebSearch: false,
    });
    await expect(operation).rejects.toBeInstanceOf(OpenAIProviderError);
    await expect(operation).rejects.toMatchObject({
      message: "OpenAI request failed",
    });
  });

  it("requires a server configuration instead of silently selecting a fake", () => {
    expect(() => requireOpenAIConfig({})).toThrowError(
      "OPENAI_API_KEY is required when OPENAI_PROVIDER=openai",
    );
    expect(
      requireOpenAIConfig({
        OPENAI_API_KEY: "test-key",
        OPENAI_RESEARCH_MODEL: "custom-research",
      }),
    ).toEqual({
      apiKey: "test-key",
      researchModel: "custom-research",
      fastModel: "gpt-5.6-luna",
    });
  });
});
