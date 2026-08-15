import type { z } from "zod";

export type StructuredResponseRequest<T> = {
  agent: string;
  model: string;
  instructions: string;
  input: Record<string, unknown>;
  outputSchema: z.ZodType<T>;
  outputName: string;
  useWebSearch: boolean;
};

export type LiveSourceProvenance =
  "tool_observed" | "model_declared_after_search";

export type StructuredResponseSource = {
  url: string;
  title?: string;
  provenance: LiveSourceProvenance;
};

export type StructuredResponseResult<T> = {
  responseId: string;
  model: string;
  output: T;
  sources: StructuredResponseSource[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  } | null;
  /** Null when the surface does not report tool activity at all. */
  toolUsage: { webSearchCalls: number } | null;
  costUsd: number | null;
  costAvailability: "available" | "unavailable";
};

export interface StructuredAIProvider {
  run<T>(
    request: StructuredResponseRequest<T>,
  ): Promise<StructuredResponseResult<T>>;
}
