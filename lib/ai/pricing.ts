import type { EmbeddingModelId, ModelId } from "@/lib/ai/models";

// US dollars per million tokens: Google's list prices as of 2026-10.
// Billing may differ slightly; these are for cost estimates.
// A free Google AI Studio key isn't charged for any of these. 3.6 Flash's
// list price doubles on 2027-01-01 ($1.50 input, $7.50 output).
export const PRICING: Record<ModelId, { input: number; output: number }> = {
  "google/gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "google/gemini-3-flash": { input: 0.5, output: 3 },
};

// Embeddings only have input tokens. This is the paid list price; the free
// tier of a Google AI Studio key doesn't charge for them.
export const EMBEDDING_PRICING: Record<EmbeddingModelId, { input: number }> = {
  "google/gemini-embedding-001": { input: 0.15 },
};

export function embeddingCostUsd(
  model: EmbeddingModelId,
  inputTokens: number,
): number {
  return (inputTokens * EMBEDDING_PRICING[model].input) / 1_000_000;
}

export function costUsd(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
