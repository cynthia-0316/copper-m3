# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document index

**Summary:** The four customer PDFs are read once, split into passages and
embedded, then saved as one JSON file the app loads into memory. This is the
index Ask Copper will search to answer from the documents.

| Piece | Where | What it does |
|---|---|---|
| Documents | `public/docs/*.pdf` (names in `lib/copper/documents.ts`) | The four PDFs, 32 pages |
| PDF reading | `lib/copper/rag/pdf.ts` | `readPdfPages()`: the text of each page (uses `unpdf`, a dev dependency) |
| Splitting | `lib/copper/rag/chunk.ts` | `buildPassages()`: removes each page's header, keeps a section, table or question with its answer together, never crosses a page. Every passage starts with its document title and keeps its page number |
| Vectors | `lib/copper/rag/vectors.ts` | `normalize()`: scales each embedding to length 1 (Gemini only does this at full size), so a dot product is a cosine similarity |
| Index | `lib/copper/rag/passages.ts`, `lib/copper/data/passages.json` | `loadPassages()` reads the JSON once and keeps it in memory; `checkIndex()` validates it |
| Build script | `scripts/build-index.ts`, `npm run index:build` | A dry run by default (no model call). `-- --embed` embeds the passages, reusing any already in the saved index |
| AI calls | `lib/ai/call.ts` `callEmbed` (`{ module: 3, feature: "build-index" }`) | `gemini-embedding-001`, 768 dimensions, `RETRIEVAL_DOCUMENT`. About 7,000 input tokens in 2 requests for all passages |

**Data flow:** PDFs → pages → passages (title + text + page) → `callEmbed` →
normalized vectors → `passages.json` → memory.

**Decisions and trade-offs:**

- *Sections stay whole.* A returns, warranty or error-code section is one
  passage when it fits (about 1,100 characters), so a rule and its conditions
  are never split. A longer section is split with its heading repeated.
- *768 dimensions* keeps the JSON small; the vectors are normalized again
  because Gemini only returns unit-length vectors at full size.
- *Free tier.* Passages are sent in small batches with a pause between them,
  to stay under the free tier's tokens-per-minute limit.
- *Questions* must be embedded with `RETRIEVAL_QUERY` and the same 768
  dimensions as the passages.

**Risks and open questions:** text inside the guides' images isn't extracted;
the free tier's limits can change, so `--embed` stops and keeps what it has if
a request is refused.

## Module 3: The `search_docs` tool

**Summary:** Ask Copper's fifth tool. For setup, troubleshooting, error codes,
warranty, returns, refunds and privacy questions it searches the document
index and returns the 5 closest passages, each with its document title, page
and a link that opens the PDF at that page.

| Piece | Where | What it does |
|---|---|---|
| Search | `lib/copper/rag/search.ts` | `searchDocs(query)`: embeds the question, scores every passage by dot product (cosine similarity), returns the top 5 as `{ title, page, link, text, score }` |
| Tool | `lib/copper/assistant/tools.ts` | `copperTools.search_docs`, described to the model, input `{ query }` |
| Instructions | `lib/copper/assistant/instructions.ts` | Tells Copper to answer these questions only from the passages and to say which document and page each fact came from |
| Tool card | `components/copper/ask-copper.tsx` | Lists each result: title, page, the start of the passage, similarity, and an "Open page N" link |
| Labels | `lib/copper/assistant/progress.ts` | `TOOL_LABELS.search_docs` |
| AI calls | `lib/ai/call.ts` `callEmbed` (`{ module: 3, feature: "search-docs" }`) | One `gemini-embedding-001` call per search: 768 dimensions, `RETRIEVAL_QUERY`, one short text |

**Data flow:** question → Copper calls `search_docs` → question embedded
(`RETRIEVAL_QUERY`) → compared with the passages in memory → 5 results → tool
card and model → reply that cites the document and page.

**Decisions and trade-offs:**

- *Always 5 results, no cut-off.* The model decides whether they answer the
  question; the card shows each similarity so a weak match is visible.
- *Links use `#page=N`,* which the browser's built-in PDF viewer opens at that
  page. The PDFs are served from `public/docs/`.
- *Failures are answers, not crashes.* No key, a refused request or an index
  built with another model comes back as `status: "unavailable"` with a plain
  message, so Copper says it can't search instead of guessing.
- *The index is imported like `catalog.json`,* so it is bundled into the
  deployed app. Only the question is embedded at search time.

**Risks and open questions:** a search costs one embedding call (free tier, a
few tokens); a vague question still returns 5 passages; the documents contain
conflicting facts on purpose, so answers should always cite a page.

## Module 3: Answers with sources

**Summary:** Copper answers setup, troubleshooting, warranty and policy
questions only from the passages `search_docs` returns, and ends each fact with
a clickable source such as `[Copper Home User Guide, p. 9]` that opens that PDF
page. When the documents don't answer, Copper says so instead of guessing.

| Piece | Where | What it does |
|---|---|---|
| Instructions | `lib/copper/assistant/instructions.ts` | The rules: search first, answer only from the passages, cite every fact as `[Document title, p. N](link)` copied from the result, never cite a passage that doesn't say it. `NOT_FOUND` is the exact reply when the documents don't answer |
| Citation checks | `lib/copper/assistant/citations.ts` | `sourcesOf()` collects what `search_docs` returned in an answer; `splitReply()` marks each citation verified only if its label and link match one of those passages; `sentencesWithoutCitation()` finds uncited sentences (used by the tests) |
| Reply | `components/copper/ask-copper.tsx` (`ReplyText`) | Draws a verified citation as a link that opens the PDF page in a new tab; any other citation or link is plain flagged text, never a link |

**Data flow:** question → `search_docs` (5 passages, each with title, page and
link) → the model writes a reply citing them → the panel checks each citation
against those passages → verified ones become links.

**Decisions and trade-offs:**

- *Verified by the passages, not by the model.* The panel only links a
  citation that matches a passage returned for that answer, so a made-up page
  or a link to another site can't become a clickable source.
- *No similarity cut-off.* Whether the passages answer the question is the
  model's call, guided by the instructions. A cut-off would be unreliable: a
  bare error code like "C-47" scores only about 0.58 even on its right passage.
- *The fallback is a sentence, not code:* `NOT_FOUND` followed by a suggestion
  to contact the Copper Crew, with no citations.
- *The chat model is Gemini 3.6 Flash.* Gemini 2.5 Flash, the earlier default,
  was deprecated and answered 404 on 2026-11-05 (its shutdown is listed as
  2026-12-01). 3.6 Flash is the stable model Google points to, with a free
  tier. Gemini 3 models are asked how hard to think with `thinkingLevel`;
  2.5 keeps its `thinkingBudget`. Never both (`thoughtSummaries` in
  `lib/ai/call.ts`). The embedding model is unchanged.

**Risks and open questions:** the checks confirm a citation points at a
passage that was retrieved, not that the sentence is true to it; only the
instructions (and a live test) cover that. Offline tests use a mock model that
follows the rules, so they can't show the real model does.
