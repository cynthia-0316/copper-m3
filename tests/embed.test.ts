// @vitest-environment node
import { MockEmbeddingModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, callEmbed } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { embeddingCostUsd } from "@/lib/ai/pricing";

// No real model is ever called: Google hands back the mock the test sets.
let model: MockEmbeddingModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => ({ embedding: () => model }),
}));

/** A mock that reports `tokens` of usage, or none at all when null. */
function mockModel(tokens: number | null = 40) {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [0.1, 0.2, 0.3]),
      usage: tokens === null ? undefined : { tokens },
      warnings: [],
    }),
  });
}

function captureLog() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    info.mock.calls
      .filter(([tag]) => tag === "[ai_calls]")
      .map(([, row]) => JSON.parse(row as string));
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  model = mockModel();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the embedding model", () => {
  it("is gemini-embedding-001 at 768 dimensions", () => {
    expect(EMBEDDING_MODEL.googleId).toBe("gemini-embedding-001");
    expect(EMBEDDING_MODEL.dimensions).toBe(768);
  });

  it("prices input tokens per million", () => {
    expect(embeddingCostUsd("google/gemini-embedding-001", 1_000_000)).toBe(
      0.15,
    );
  });
});

describe("callEmbed", () => {
  it("returns one embedding per text, in order", async () => {
    const result = await callEmbed(
      { module: 3, feature: "build-index" },
      { values: ["a", "b", "c"], taskType: "RETRIEVAL_DOCUMENT" },
    );
    expect(result.embeddings).toHaveLength(3);
    expect(result.tokens).toBe(40);
  });

  it("asks for 768 dimensions and the document task type", async () => {
    await callEmbed(
      { module: 3, feature: "build-index" },
      { values: ["a"], taskType: "RETRIEVAL_DOCUMENT" },
    );
    const call = model.doEmbedCalls[0];
    expect(call.values).toEqual(["a"]);
    expect(JSON.stringify(call.providerOptions)).toContain(
      "RETRIEVAL_DOCUMENT",
    );
    expect(call.dimensions).toBe(768);
  });

  it("logs one [ai_calls] row with tokens and cost", async () => {
    const rows = captureLog();
    await callEmbed(
      { module: 3, feature: "build-index" },
      { values: ["a", "b"], taskType: "RETRIEVAL_DOCUMENT" },
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      module: 3,
      feature: "build-index",
      model: "google/gemini-embedding-001",
      input_tokens: 40,
      output_tokens: null,
      ok: true,
    });
    expect(rows()[0].cost_usd).toBeCloseTo(0.000006, 9);
  });

  it("logs null tokens and cost when the provider doesn't report usage", async () => {
    model = mockModel(null);
    const rows = captureLog();
    await callEmbed(
      { module: 3, feature: "build-index" },
      { values: ["a"], taskType: "RETRIEVAL_QUERY" },
    );
    expect(rows()[0]).toMatchObject({ input_tokens: null, cost_usd: null });
  });

  it("logs a failed call and rethrows", async () => {
    model = new MockEmbeddingModelV4({
      doEmbed: async () => {
        throw new Error("quota exceeded");
      },
    });
    const rows = captureLog();
    await expect(
      callEmbed(
        { module: 3, feature: "build-index" },
        { values: ["a"], taskType: "RETRIEVAL_DOCUMENT" },
      ),
    ).rejects.toThrow();
    expect(rows()[0]).toMatchObject({ ok: false, input_tokens: null });
  });

  it("makes no call and no log without a key", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const rows = captureLog();
    await expect(
      callEmbed(
        { module: 3, feature: "build-index" },
        { values: ["a"], taskType: "RETRIEVAL_DOCUMENT" },
      ),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(model.doEmbedCalls).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("does nothing for an empty list", async () => {
    const result = await callEmbed(
      { module: 3, feature: "build-index" },
      { values: [], taskType: "RETRIEVAL_DOCUMENT" },
    );
    expect(result.embeddings).toEqual([]);
    expect(model.doEmbedCalls).toHaveLength(0);
  });
});
