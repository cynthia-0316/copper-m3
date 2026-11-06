// @vitest-environment node
// Step 6, offline: answers with sources. Gemini is replaced by mocks, so no key
// is needed and nothing is sent anywhere.
//
// What these tests prove: Copper's instructions say what the professor asked;
// the pipeline hands the model real passages with titles, pages and links; and
// the citation checks accept a reply that cites those passages correctly and
// flag one that doesn't. The mock "model" plays a model that follows the
// instructions, writing its citations from the tool result it was given. What
// they can't prove is that the real model follows the instructions: that is
// what the live test is for.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  convertArrayToReadableStream,
  MockEmbeddingModelV4,
  MockLanguageModelV4,
} from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import {
  citationLabel,
  citationsIn,
  sentencesWithoutCitation,
  sourcesOf,
  splitReply,
} from "@/lib/copper/assistant/citations";
import {
  COPPER_INSTRUCTIONS,
  NOT_FOUND,
} from "@/lib/copper/assistant/instructions";
import { loadPassages, type IndexedPassage } from "@/lib/copper/rag/passages";
import type { DocHit } from "@/lib/copper/rag/search";

let embedModel: MockEmbeddingModelV4;
let chatModel: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () =>
    Object.assign(() => chatModel, { embedding: () => embedModel }),
}));

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------

describe("Copper's instructions", () => {
  it("send setup, troubleshooting, warranty and policy questions to search_docs, and nothing else", () => {
    for (const topic of [
      "setup",
      "troubleshooting",
      "warranty",
      "returns",
      "refunds",
      "policy",
    ]) {
      expect(COPPER_INSTRUCTIONS).toContain(topic);
    }
    expect(COPPER_INSTRUCTIONS).toContain("search_docs");
    expect(COPPER_INSTRUCTIONS).toMatch(/answer only from the passages/i);
  });

  it("require a clickable citation with title, page and the PDF-page link on every fact", () => {
    expect(COPPER_INSTRUCTIONS).toMatch(/Cite every fact/);
    expect(COPPER_INSTRUCTIONS).toContain("[Document title, p. N](link)");
    expect(COPPER_INSTRUCTIONS).toContain(
      "[Copper Home User Guide, p. 9](/docs/copper-home-user-guide.pdf#page=9)",
    );
    expect(COPPER_INSTRUCTIONS).toMatch(/exactly as search_docs returned/);
  });

  it("forbid citing a passage that doesn't say it, and making sources up", () => {
    expect(COPPER_INSTRUCTIONS).toMatch(/Only cite a passage that really says/);
    expect(COPPER_INSTRUCTIONS).toMatch(/never make up a title, page or link/i);
    expect(COPPER_INSTRUCTIONS).toMatch(/from memory/);
  });

  it("give the exact not-found reply and send the shopper to the Copper Crew", () => {
    expect(NOT_FOUND).toBe("I couldn't find that in our support docs.");
    expect(COPPER_INSTRUCTIONS).toContain(`exactly "${NOT_FOUND}"`);
    expect(COPPER_INSTRUCTIONS).toMatch(/contacting the Copper Crew/);
    expect(COPPER_INSTRUCTIONS).toMatch(/ordering a pizza/);
  });

  it("keep the Module 2 rules for prices, totals and stock", () => {
    expect(COPPER_INSTRUCTIONS).toContain("calculate_cost");
    expect(COPPER_INSTRUCTIONS).toContain("get_products");
    expect(COPPER_INSTRUCTIONS).toContain("check_availability");
  });
});

// ---------------------------------------------------------------------------
// The citation checks
// ---------------------------------------------------------------------------

const HOME_9 = {
  title: "Copper Home User Guide",
  page: 9,
  link: "/docs/copper-home-user-guide.pdf#page=9",
};
const cite = (hit: { title: string; page: number; link: string }) =>
  `[${citationLabel(hit)}](${hit.link})`;

describe("citations", () => {
  const sources = new Map([[HOME_9.link, citationLabel(HOME_9)]]);

  it("labels a source the way the professor shows it", () => {
    expect(citationLabel(HOME_9)).toBe("Copper Home User Guide, p. 9");
  });

  it("verifies a citation that matches a retrieved passage's label and link", () => {
    const [text, citation] = splitReply(
      `C-47 is a microphone fault ${cite(HOME_9)}`,
      sources,
    );
    expect(text).toMatchObject({ type: "text" });
    expect(citation).toEqual({
      type: "citation",
      label: "Copper Home User Guide, p. 9",
      href: "/docs/copper-home-user-guide.pdf#page=9",
      verified: true,
    });
  });

  it("flags a citation whose page, link or document wasn't retrieved", () => {
    const bad = [
      // The right link under the wrong page number.
      "[Copper Home User Guide, p. 4](/docs/copper-home-user-guide.pdf#page=9)",
      // A page that wasn't in the results.
      "[Copper Home User Guide, p. 4](/docs/copper-home-user-guide.pdf#page=4)",
      // A document that wasn't in the results.
      "[Copper Notes User Guide, p. 8](/docs/copper-notes-user-guide.pdf#page=8)",
      // Not one of Copper's PDFs at all.
      "[Copper Home User Guide, p. 9](https://example.com/page=9)",
    ];
    for (const reply of bad) {
      const citation = splitReply(reply, sources).find(
        (s) => s.type === "citation",
      );
      expect(citation, reply).toMatchObject({ verified: false });
    }
  });

  it("flags every citation when nothing was searched", () => {
    const segments = splitReply(`Yes ${cite(HOME_9)}`, new Map());
    expect(segments.find((s) => s.type === "citation")).toMatchObject({
      verified: false,
    });
  });

  it("collects the sources of every successful search_docs call, and ignores the rest", () => {
    const step = (name: string, output: unknown) => ({
      type: "tool" as const,
      id: name,
      name,
      state: "done" as const,
      output,
    });
    const map = sourcesOf([
      step("search_docs", { status: "ok", results: [HOME_9] }),
      step("search_docs", { status: "unavailable", message: "down" }),
      step("get_prices", { products: [] }),
    ]);
    expect([...map]).toEqual([[HOME_9.link, "Copper Home User Guide, p. 9"]]);
  });

  it("finds sentences that carry no citation", () => {
    const c = cite(HOME_9);
    expect(sentencesWithoutCitation(`Unplug it for 30 seconds ${c}.`)).toEqual(
      [],
    );
    expect(sentencesWithoutCitation(`Unplug it for 30 seconds. ${c}`)).toEqual(
      [],
    );
    expect(
      sentencesWithoutCitation(`Unplug it ${c}. Then wait. Plug it in ${c}.`),
    ).toEqual(["Then wait."]);
    expect(sentencesWithoutCitation(`- Unplug it ${c}\n- Plug it in`)).toEqual([
      "- Plug it in",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The four required questions, through askCopper with mocked models
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
const callsSearch = (query: string): ModelStreamPart[] => [
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
const says = (text: string): ModelStreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

/** The passages search_docs handed back, as the model's second step sees them. */
function searchResultsIn(prompt: unknown): DocHit[] {
  for (const message of prompt as {
    role: string;
    content: { type: string; output?: { value?: { results?: DocHit[] } } }[];
  }[]) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.output?.value?.results) {
        return part.output.value.results;
      }
    }
  }
  throw new Error("The model was not given any search results.");
}

/** A mock model that searches, then answers with what `reply` writes from the results. */
function modelThatSearches(query: string, reply: (hits: DocHit[]) => string) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => ({
      stream: convertArrayToReadableStream(
        step++ === 0
          ? callsSearch(query)
          : says(reply(searchResultsIn(prompt))),
      ),
    }),
  });
}

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

async function passageWith(...parts: string[]): Promise<IndexedPassage> {
  const { passages } = await loadPassages();
  const found = passages.filter((p) => parts.every((s) => p.text.includes(s)));
  expect(found, parts.join(" + ")).toHaveLength(1);
  return found[0];
}

async function ask(question: string) {
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue(
    (
      await askCopper({
        messages: [{ role: "user", content: question }],
        useTools: true,
      })
    ).progress,
  );
}

type Scenario = {
  name: string;
  question: string;
  query: string;
  /** Text only the passage that answers the question contains. */
  passage: string[];
  source: { title: string; page: number; link: string };
  /** What the reply says; each claim is checked against the cited passage. */
  claims: { sentence: string; words: string[] }[];
};

const SCENARIOS: Scenario[] = [
  {
    name: "C-47 troubleshooting",
    question: "What does error code C-47 mean?",
    query: "C-47",
    passage: ["C-47", "Microphone array fault"],
    source: HOME_9,
    claims: [
      {
        sentence: "C-47 is a microphone array fault",
        words: ["C-47", "Microphone array fault"],
      },
      {
        sentence: "Unplug Copper Home for 30 seconds, then plug it back in",
        words: ["Unplug Copper Home for 30 seconds"],
      },
    ],
  },
  {
    name: "annual Copper Plus refund policy",
    question: "Can I get a refund on an annual Copper Plus plan?",
    query: "annual Copper Plus refund",
    passage: ["4.6 Refunds", "Annual"],
    source: {
      title: "Copper State Labs Terms and Conditions",
      page: 4,
      link: "/docs/copper-terms-and-conditions.pdf#page=4",
    },
    claims: [
      {
        sentence:
          "You get a full refund if you cancel an annual plan within 14 days of purchase",
        words: ["Full refund if you cancel within 14 days of purchase"],
      },
      {
        sentence: "After 14 days, an annual plan is not refunded",
        words: ["After 14", "not refunded"],
      },
    ],
  },
  {
    name: "Wi-Fi troubleshooting",
    question: "My Copper Home lost its Wi-Fi. What do I do?",
    query: "Copper Home lost Wi-Fi connection",
    // Copper Notes has a C-12 row too, so the passage is told apart by its product.
    passage: ["C-12", "Wi-Fi connection lost", "Copper Home"],
    source: HOME_9,
    claims: [
      {
        sentence:
          "Code C-12 means the Wi-Fi connection was lost, or the Wi-Fi password is wrong",
        words: ["C-12", "Wi-Fi connection lost"],
      },
      {
        sentence:
          "Re-enter your Wi-Fi details in the Copper app and move Copper Home closer to the router",
        words: [
          "Re-enter your Wi-Fi details in the Copper app",
          "closer to the",
        ],
      },
    ],
  },
];

describe("answers with sources (mocked models)", () => {
  it.each(SCENARIOS)(
    "$name: cites the right passage, with a link to the right PDF page",
    async (s) => {
      const target = await passageWith(...s.passage);
      embedModel = embedsAs(target.embedding.map((x) => x * 3));
      chatModel = modelThatSearches(s.query, (hits) => {
        // A model that follows the instructions: it cites the passage that
        // answers the question, exactly as search_docs returned it.
        const hit = hits.find((h) =>
          s.passage.every((w) => h.text.includes(w)),
        )!;
        return s.claims.map((c) => `${c.sentence} ${cite(hit)}.`).join(" ");
      });

      const result = await ask(s.question);
      expect(result.status).toBe("done");

      // The model searched before answering, and was told how to answer.
      const names = result.steps.flatMap((step) =>
        step.type === "tool" ? [step.name] : [],
      );
      expect(names).toEqual(["search_docs"]);
      const system = chatModel.doStreamCalls[0].prompt.find(
        (m) => m.role === "system",
      );
      expect(JSON.stringify(system?.content)).toContain(NOT_FOUND);

      // Every sentence is cited, each citation matches a retrieved passage,
      // and it is the right document and page, linking to that PDF page.
      expect(sentencesWithoutCitation(result.reply)).toEqual([]);
      const citations = citationsIn(result.reply);
      expect(citations).toHaveLength(s.claims.length);
      for (const citation of citations) {
        expect(citation).toEqual({
          label: citationLabel(s.source),
          href: s.source.link,
        });
      }
      const segments = splitReply(result.reply, sourcesOf(result.steps));
      const found = segments.filter((seg) => seg.type === "citation");
      expect(found).toHaveLength(s.claims.length);
      expect(found.every((c) => c.type === "citation" && c.verified)).toBe(
        true,
      );

      // The cited passage really says what each sentence says.
      const cited = (
        result.steps.find((step) => step.type === "tool")!.output as {
          results: DocHit[];
        }
      ).results.find(
        (h) =>
          h.link === s.source.link &&
          s.passage.every((w) => h.text.includes(w)),
      )!;
      for (const claim of s.claims) {
        for (const word of claim.words) expect(cited.text).toContain(word);
      }
    },
  );

  it('"Can Copper Home order me a pizza?" gets the exact fallback and no citations', async () => {
    // A question about nothing in the documents: its vector is far from every passage.
    const unrelated = new Array(768).fill(0).map((_, i) => (i === 5 ? 1 : 0));
    embedModel = embedsAs(unrelated);
    chatModel = modelThatSearches(
      "order a pizza",
      () => `${NOT_FOUND} Please contact the Copper Crew.`,
    );

    const result = await ask("Can Copper Home order me a pizza?");
    expect(result.status).toBe("done");

    // It did search, and nothing it found is about pizza.
    const search = result.steps.find((s) => s.type === "tool")!.output as {
      status: string;
      results: DocHit[];
    };
    expect(search.status).toBe("ok");
    expect(JSON.stringify(search.results)).not.toMatch(/pizza/i);

    // The reply starts with the required sentence, suggests the Copper Crew,
    // and cites nothing.
    expect(result.reply.startsWith(NOT_FOUND)).toBe(true);
    expect(result.reply).toBe(
      "I couldn't find that in our support docs. Please contact the Copper Crew.",
    );
    expect(result.reply).toMatch(/Copper Crew/);
    expect(citationsIn(result.reply)).toEqual([]);
  });

  it("hands the model the passages, titles, pages and links it must cite", async () => {
    const target = await passageWith("C-47", "Microphone array fault");
    embedModel = embedsAs(target.embedding);
    let seen: DocHit[] = [];
    chatModel = modelThatSearches("C-47", (hits) => {
      seen = hits;
      return "Ok.";
    });
    await ask("What does error code C-47 mean?");
    expect(seen).toHaveLength(5);
    for (const hit of seen) {
      expect(hit.link).toBe(`${hit.link.split("#")[0]}#page=${hit.page}`);
      expect(hit.title).toMatch(/^Copper/);
      expect(hit.text.length).toBeGreaterThan(0);
    }
    expect(seen[0]).toMatchObject(HOME_9);
  });

  it("still has all five tools, so nothing Copper could do before is lost", async () => {
    embedModel = embedsAs(
      new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    );
    chatModel = modelThatSearches("anything", () => "Ok.");
    await ask("anything");
    const names = (chatModel.doStreamCalls[0].tools ?? []).map((t) => t.name);
    expect(names.sort()).toEqual([
      "calculate_cost",
      "check_availability",
      "get_prices",
      "get_products",
      "search_docs",
    ]);
  });
});
