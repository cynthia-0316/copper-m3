// @vitest-environment node
// search_docs, offline: Gemini is replaced by mocks, so no key is needed and
// nothing is sent anywhere. The mock "embeds" a question as the vector of the
// passage that should answer it; that proves the plumbing (ranking, titles,
// pages, links, logging), not how well the real model understands a question.
// Real questions are tried in the live test, with approval.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  convertArrayToReadableStream,
  MockEmbeddingModelV4,
  MockLanguageModelV4,
} from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { copperTools } from "@/lib/copper/assistant/tools";
import {
  loadPassages,
  type IndexedPassage,
  type PassageIndex,
} from "@/lib/copper/rag/passages";
import {
  pdfLink,
  SEARCH_RESULTS,
  searchDocs,
  searchDocsInput,
} from "@/lib/copper/rag/search";

let embedModel: MockEmbeddingModelV4;
let chatModel: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () =>
    Object.assign(() => chatModel, { embedding: () => embedModel }),
}));

let logged: Record<string, unknown>[] = [];

/** A mock embedding model that answers every question with `vector`. */
function embedsAs(vector: number[]) {
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => vector),
      usage: { tokens: 4 },
      warnings: [],
    }),
  });
}

/** The saved passage with this text in it (the passage a question should find). */
async function passageWith(...parts: string[]): Promise<IndexedPassage> {
  const { passages } = await loadPassages();
  const found = passages.filter((p) => parts.every((s) => p.text.includes(s)));
  expect(found, parts.join(" + ")).toHaveLength(1);
  return found[0];
}

/** The same direction, but not length 1, like a model that doesn't normalize. */
const scaled = (vector: number[]) => vector.map((x) => x * 3);

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  logged = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[ai_calls]") logged.push(JSON.parse(args[1] as string));
  });
  embedModel = embedsAs(
    new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("searchDocs: the three required questions", () => {
  it('"C-47" finds the Copper Home error-code table, with its page and a link', async () => {
    const target = await passageWith("C-47", "Microphone array fault");
    embedModel = embedsAs(scaled(target.embedding));
    const result = await searchDocs("C-47");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.results[0]).toMatchObject({
      title: "Copper Home User Guide",
      page: 9,
      link: "/docs/copper-home-user-guide.pdf#page=9",
    });
    expect(result.results[0].text).toContain("C-47");
    expect(result.results[0].score).toBeCloseTo(1, 3);
  });

  it('"annual refund" finds the subscription refund rule in the Terms', async () => {
    const target = await passageWith("4.6 Refunds", "Annual");
    embedModel = embedsAs(scaled(target.embedding));
    const result = await searchDocs("annual refund");
    if (result.status !== "ok") throw new Error("expected results");
    expect(result.results[0]).toMatchObject({
      title: "Copper State Labs Terms and Conditions",
      page: 4,
      link: "/docs/copper-terms-and-conditions.pdf#page=4",
    });
    expect(result.results[0].text).toContain("4.6 Refunds");
  });

  it('"reset Wi-Fi" finds the Wi-Fi setup page of the Copper Home guide', async () => {
    const target = await passageWith("3 Wi-Fi and connection");
    embedModel = embedsAs(scaled(target.embedding));
    const result = await searchDocs("reset Wi-Fi");
    if (result.status !== "ok") throw new Error("expected results");
    expect(result.results[0]).toMatchObject({
      title: "Copper Home User Guide",
      page: 4,
      link: "/docs/copper-home-user-guide.pdf#page=4",
    });
  });
});

describe("searchDocs: the results", () => {
  it("returns the 5 closest passages, best first, each with title, page, link and text", async () => {
    const target = await passageWith("C-47", "Microphone array fault");
    embedModel = embedsAs(target.embedding);
    const result = await searchDocs("C-47");
    if (result.status !== "ok") throw new Error("expected results");
    expect(SEARCH_RESULTS).toBe(5);
    expect(result.results).toHaveLength(5);
    const scores = result.results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(result.results.map((r) => r.id)).size).toBe(5);
    for (const hit of result.results) {
      expect(hit.title).toMatch(/Copper/);
      expect(Number.isInteger(hit.page)).toBe(true);
      expect(hit.link).toMatch(/^\/docs\/[a-z-]+\.pdf#page=\d+$/);
      expect(hit.link.endsWith(`#page=${hit.page}`)).toBe(true);
      // The passage is returned without its title line.
      expect(hit.text.startsWith(hit.title)).toBe(false);
      expect(hit.text.length).toBeGreaterThan(20);
    }
  });

  it("returns fewer when the index has fewer passages", async () => {
    const vector = new Array(768).fill(0);
    const unit = (i: number) => vector.map((_, n) => (n === i ? 1 : 0));
    const passages: IndexedPassage[] = [0, 1, 2].map((i) => ({
      id: `doc-p${i + 1}-1`,
      documentId: "doc",
      title: "Doc",
      file: "/docs/doc.pdf",
      page: i + 1,
      text: `Doc\nPassage ${i}`,
      embedding: unit(i),
    }));
    const tiny: PassageIndex = {
      model: EMBEDDING_MODEL.id,
      dimensions: 768,
      taskType: "RETRIEVAL_DOCUMENT",
      normalized: true,
      complete: true,
      createdAt: "2026-11-05T00:00:00.000Z",
      passages,
    };
    embedModel = embedsAs(unit(1));
    const result = await searchDocs("anything", { index: tiny });
    if (result.status !== "ok") throw new Error("expected results");
    expect(result.results.map((r) => r.id)).toEqual([
      "doc-p2-1",
      "doc-p1-1",
      "doc-p3-1",
    ]);
    expect(result.results[0].score).toBe(1);
    expect(result.results[0].text).toBe("Passage 1");
  });

  it("scores the same whether or not the model's vector has length 1", async () => {
    const target = await passageWith("C-47", "Microphone array fault");
    embedModel = embedsAs(target.embedding);
    const plain = await searchDocs("C-47");
    embedModel = embedsAs(scaled(target.embedding));
    const big = await searchDocs("C-47");
    if (plain.status !== "ok" || big.status !== "ok") throw new Error("failed");
    expect(big.results.map((r) => r.score)).toEqual(
      plain.results.map((r) => r.score),
    );
  });
});

describe("searchDocs: the model call", () => {
  it("embeds the question as a RETRIEVAL_QUERY at 768 dimensions, once", async () => {
    await searchDocs("reset Wi-Fi");
    expect(embedModel.doEmbedCalls).toHaveLength(1);
    const call = embedModel.doEmbedCalls[0];
    expect(call.values).toEqual(["reset Wi-Fi"]);
    expect(call.dimensions).toBe(768);
    expect(JSON.stringify(call.providerOptions)).toContain("RETRIEVAL_QUERY");
    expect(EMBEDDING_MODEL.googleId).toBe("gemini-embedding-001");
  });

  it("logs the call to ai_calls as module 3, feature search-docs", async () => {
    await searchDocs("C-47");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      module: 3,
      feature: "search-docs",
      model: "google/gemini-embedding-001",
      input_tokens: 4,
      ok: true,
    });
  });

  it("does not re-embed the passages: only the question is sent", async () => {
    await searchDocs("C-47");
    await searchDocs("annual refund");
    expect(embedModel.doEmbedCalls.map((c) => c.values)).toEqual([
      ["C-47"],
      ["annual refund"],
    ]);
  });
});

describe("searchDocs: when it can't search", () => {
  it("says so without a key, and makes no call", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const result = await searchDocs("C-47");
    expect(result).toEqual({
      status: "unavailable",
      message: expect.stringMatching(/needs AI to be set up/),
    });
    expect(embedModel.doEmbedCalls).toHaveLength(0);
  });

  it("says so when the model call fails, without leaking the error", async () => {
    embedModel = new MockEmbeddingModelV4({
      doEmbed: async () => {
        throw new Error("429 quota exceeded for key AIza-secret");
      },
    });
    const result = await searchDocs("C-47");
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(/AIza|429|quota/);
    expect(logged[0]).toMatchObject({ ok: false });
  });

  it("refuses an index built with another model or size, without calling the model", async () => {
    const saved = await loadPassages();
    for (const wrong of [
      { ...saved, model: "google/other-embedding" },
      { ...saved, dimensions: 3072 },
    ]) {
      const result = await searchDocs("C-47", { index: wrong });
      expect(result.status).toBe("unavailable");
    }
    expect(embedModel.doEmbedCalls).toHaveLength(0);
  });
});

describe("the search_docs tool", () => {
  it("sits beside the four existing tools, described for the model", () => {
    expect(Object.keys(copperTools)).toEqual(
      expect.arrayContaining([
        "get_products",
        "get_prices",
        "calculate_cost",
        "check_availability",
        "search_docs",
      ]),
    );
    const { description } = copperTools.search_docs;
    for (const topic of ["setup", "troubleshooting", "warranty", "refunds"]) {
      expect(description).toContain(topic);
    }
    expect(description).toMatch(/5 most relevant/);
    expect(typeof copperTools.search_docs.execute).toBe("function");
  });

  it("takes a non-empty question of reasonable length", () => {
    expect(searchDocsInput.parse({ query: "  C-47  " })).toEqual({
      query: "C-47",
    });
    expect(searchDocsInput.safeParse({ query: "" }).success).toBe(false);
    expect(searchDocsInput.safeParse({ query: "   " }).success).toBe(false);
    expect(searchDocsInput.safeParse({ query: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(searchDocsInput.safeParse({}).success).toBe(false);
  });

  it("builds page links the browser's PDF viewer understands", () => {
    expect(pdfLink("/docs/a.pdf", 3)).toBe("/docs/a.pdf#page=3");
  });

  it("tells Copper to use it, and to cite the document and page", () => {
    expect(COPPER_INSTRUCTIONS).toContain("search_docs");
    expect(COPPER_INSTRUCTIONS).toMatch(/warranty/);
    expect(COPPER_INSTRUCTIONS).toMatch(/page/);
  });
});

// ---------------------------------------------------------------------------
// The whole path: Copper calls the tool, the tool searches, Copper answers.
// ---------------------------------------------------------------------------

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage,
});
type Part = ModelStreamPart;
const callsSearch = (query: string): Part[] => [
  { type: "tool-input-start", id: "call-1", toolName: "search_docs" },
  { type: "tool-input-delta", id: "call-1", delta: JSON.stringify({ query }) },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "search_docs",
    input: JSON.stringify({ query }),
  },
  finish("tool-calls"),
];
const says = (text: string): Part[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

describe("askCopper with search_docs", () => {
  it("runs the search when Copper asks for it and hands the passages back", async () => {
    const target = await passageWith("C-47", "Microphone array fault");
    embedModel = embedsAs(scaled(target.embedding));
    let step = 0;
    chatModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(
          [
            callsSearch("C-47"),
            says(
              "C-47 is a microphone fault (Copper Home User Guide, page 9).",
            ),
          ][step++],
        ),
      }),
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "What does C-47 mean?" }],
          useTools: true,
        })
      ).progress,
    );

    expect(result.status).toBe("done");
    expect(result.reply).toContain("page 9");
    const [call] = toolCallsOf(result);
    expect(call).toMatchObject({
      name: "search_docs",
      input: { query: "C-47" },
    });
    const output = call.output as Extract<
      Awaited<ReturnType<typeof searchDocs>>,
      { status: "ok" }
    >;
    expect(output.status).toBe("ok");
    expect(output.results).toHaveLength(5);
    expect(output.results[0]).toMatchObject({ page: 9 });

    // The model's second step was given the passages, links included.
    const sent = JSON.stringify(chatModel.doStreamCalls[1].prompt);
    expect(sent).toContain("copper-home-user-guide.pdf#page=9");
    // The model was offered all five tools.
    const names = (chatModel.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_docs", "get_prices"]),
    );

    // Two logged calls: the question embedding and the chat answer.
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    expect(logged.map((row) => row.feature).sort()).toEqual([
      "ask-copper",
      "search-docs",
    ]);
  });
});
