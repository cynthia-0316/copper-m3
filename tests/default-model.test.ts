// @vitest-environment node
// The default chat model is Gemini 3.6 Flash (Gemini 2.5 Flash was deprecated
// and started answering 404). Offline: a mock model stands in for Google.
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { thoughtSummaries } from "@/lib/ai/call";
import {
  DEFAULT_MODEL,
  defaultModel,
  EMBEDDING_MODEL,
  MODELS,
} from "@/lib/ai/models";
import { costUsd, PRICING } from "@/lib/ai/pricing";

let chatModel: MockLanguageModelV4;
let googleModelIds: string[] = [];
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () =>
    Object.assign(
      (id: string) => {
        googleModelIds.push(id);
        return chatModel;
      },
      { embedding: () => ({}) },
    ),
}));

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  googleModelIds = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the models", () => {
  it("make Gemini 3.6 Flash the default, called by Google's own name", () => {
    expect(DEFAULT_MODEL).toBe("google/gemini-3.6-flash");
    expect(defaultModel()).toBe("google/gemini-3.6-flash");
    const entry = MODELS.find((m) => m.id === DEFAULT_MODEL);
    expect(entry?.googleId).toBe("gemini-3.6-flash");
  });

  it("keep the two earlier models approved, and AI_MODEL can still pick one", () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      "google/gemini-3.6-flash",
      "google/gemini-2.5-flash",
      "google/gemini-3-flash",
    ]);
    vi.stubEnv("AI_MODEL", "google/gemini-3-flash");
    expect(defaultModel()).toBe("google/gemini-3-flash");
    vi.stubEnv("AI_MODEL", "google/not-a-model");
    expect(defaultModel()).toBe("google/gemini-3.6-flash");
  });

  it("have a price for the new model", () => {
    expect(PRICING["google/gemini-3.6-flash"]).toEqual({
      input: 0.75,
      output: 3.75,
    });
    // 1,000 x $0.75/M + 200 x $3.75/M = $0.0015
    expect(costUsd("google/gemini-3.6-flash", 1000, 200)).toBeCloseTo(
      0.0015,
      9,
    );
  });

  it("leave the embedding model alone", () => {
    expect(EMBEDDING_MODEL).toEqual({
      id: "google/gemini-embedding-001",
      googleId: "gemini-embedding-001",
      dimensions: 768,
    });
    const chatModels: string[] = MODELS.map((m) => m.id);
    expect(chatModels).not.toContain(EMBEDDING_MODEL.id);
  });
});

describe("thoughtSummaries", () => {
  it("asks Gemini 3 models for thought summaries with a level, never a budget", () => {
    for (const model of [
      "google/gemini-3.6-flash",
      "google/gemini-3-flash",
    ] as const) {
      const config = thoughtSummaries(model).google.thinkingConfig;
      expect(config).toEqual({ includeThoughts: true, thinkingLevel: "low" });
      expect("thinkingBudget" in config).toBe(false);
    }
  });

  it("keeps Gemini 2.5's token budget, which takes no level", () => {
    const config = thoughtSummaries("google/gemini-2.5-flash").google
      .thinkingConfig;
    expect(config).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    expect("thinkingLevel" in config).toBe(false);
  });

  it("follows the default model, and AI_MODEL", () => {
    expect(thoughtSummaries().google.thinkingConfig).toMatchObject({
      thinkingLevel: "low",
    });
    vi.stubEnv("AI_MODEL", "google/gemini-2.5-flash");
    expect(thoughtSummaries().google.thinkingConfig).toMatchObject({
      thinkingBudget: 1024,
    });
  });

  it("is what Ask Copper sends: Gemini 3.6 Flash with a thinking level and thought summaries", async () => {
    chatModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hi!" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
          },
        ]),
      }),
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Hello" }],
          useTools: true,
        })
      ).progress,
    );
    expect(result.reply).toBe("Hi!");
    expect(googleModelIds).toEqual(["gemini-3.6-flash"]);
    const sent = JSON.stringify(chatModel.doStreamCalls[0].providerOptions);
    expect(sent).toContain('"includeThoughts":true');
    expect(sent).toContain('"thinkingLevel":"low"');
    expect(sent).not.toContain("thinkingBudget");
  });
});
