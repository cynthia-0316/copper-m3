// The course's approved models. Calls go straight to Google with a Google AI
// Studio key, which is free and needs no credit card.
export const MODELS = [
  {
    id: "google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash (current default)",
    // Google's own name for it, used when calling Google.
    googleId: "gemini-3.6-flash",
    // How it is asked to think: Gemini 3 models take a level, Gemini 2.5 a
    // token budget (see thoughtSummaries in lib/ai/call.ts).
    thinking: "level",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash (deprecated: Google shuts it down on 2026-12-01)",
    googleId: "gemini-2.5-flash",
    thinking: "budget",
  },
  {
    id: "google/gemini-3-flash",
    label: "Gemini 3 Flash (preview, older)",
    googleId: "gemini-3-flash-preview",
    thinking: "level",
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

// The embedding model for Module 3's document search. It isn't in MODELS: that
// list is the chat models a call can pick from, and an embedding model can't
// write text. 768 dimensions keeps the saved index small.
export const EMBEDDING_MODEL = {
  id: "google/gemini-embedding-001",
  googleId: "gemini-embedding-001",
  dimensions: 768,
} as const;

export type EmbeddingModelId = typeof EMBEDDING_MODEL.id;

/**
 * The model used when a call doesn't name one. It was 2.5 Flash until Google
 * deprecated it (calls returned 404 on 2026-11-05); 3.6 Flash is the stable
 * model Google's own deprecation page points to, with a free tier.
 */
export const DEFAULT_MODEL: ModelId = "google/gemini-3.6-flash";

/** AI_MODEL if it names an approved model, otherwise the default. */
export function defaultModel(): ModelId {
  const id = process.env.AI_MODEL;
  return MODELS.find((m) => m.id === id)?.id ?? DEFAULT_MODEL;
}
