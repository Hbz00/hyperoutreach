import type { LiveSourceProvenance } from "@/lib/openai/providers/types";

export type AgentSource = {
  url: string;
  title?: string;
  provenance?: LiveSourceProvenance;
};

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

export type AgentToolUsage = { webSearchCalls: number };

export type AgentResult<T> = {
  responseId: string;
  model: string;
  output: T;
  sources: AgentSource[];
  usage: AgentUsage | null;
  toolUsage?: AgentToolUsage;
  costUsd: number | null;
  costAvailability?: "available" | "unavailable";
};
