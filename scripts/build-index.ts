// npm run index:build: reads the customer PDFs in public/docs/, splits each page
// into passages, and (only with --embed) embeds them and saves the index to
// lib/copper/data/passages.json.
//
//   npm run index:build                  dry run: reads and splits, no model calls
//   npm run index:build -- --print       the same, and prints every passage
//   npm run index:build -- --embed       embeds the passages (calls Gemini)
//
// Passages already embedded in the saved index are reused, so re-running only
// pays for text that changed.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { DOCUMENTS } from "@/lib/copper/documents";
import { buildPassages, type Passage } from "@/lib/copper/rag/chunk";
import {
  checkIndex,
  type IndexedPassage,
  PASSAGES_FILE,
  type PassageIndex,
} from "@/lib/copper/rag/passages";
import { readPdfPages } from "@/lib/copper/rag/pdf";
import { normalize } from "@/lib/copper/rag/vectors";

// The free tier allows about 30,000 tokens a minute, so send small batches
// with a pause: at most about 20,000 tokens a minute.
const BATCH_SIZE = 40;
const PAUSE_MS = 20_000;
// Vectors are rounded to 6 decimals: it keeps the file about half the size and
// changes a similarity score by less than 0.00001.
const DECIMALS = 1e6;

const estimateTokens = (chars: number) => Math.ceil(chars / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Loaded = {
  id: string;
  title: string;
  pages: string[];
  passages: Passage[];
};

async function readDocuments(): Promise<Loaded[]> {
  return Promise.all(
    DOCUMENTS.map(async (doc) => {
      const pages = await readPdfPages(path.join("public", doc.file));
      return {
        id: doc.id,
        title: doc.title,
        pages,
        passages: buildPassages(doc, pages),
      };
    }),
  );
}

function report(docs: Loaded[], print: boolean) {
  console.log("Passages per document");
  let total = 0;
  let chars = 0;
  const emptyPages: string[] = [];
  for (const d of docs) {
    const perPage = d.pages.map(
      (_, i) => d.passages.filter((p) => p.page === i + 1).length,
    );
    perPage.forEach((n, i) => {
      if (n === 0) emptyPages.push(`${d.id} page ${i + 1}`);
    });
    console.log(
      `  ${d.title}: ${d.passages.length} passages from ${d.pages.length} pages (per page: ${perPage.join(", ")})`,
    );
    total += d.passages.length;
    chars += d.passages.reduce((sum, p) => sum + p.text.length, 0);
  }
  const all = docs.flatMap((d) => d.passages);
  const sizes = all.map((p) => p.text.length);
  const batches = Math.ceil(total / BATCH_SIZE);
  console.log(
    `Total: ${total} passages from ${docs.reduce((s, d) => s + d.pages.length, 0)} pages`,
  );
  console.log(
    `Passage size (characters): shortest ${Math.min(...sizes)}, longest ${Math.max(...sizes)}, average ${Math.round(chars / total)}`,
  );
  console.log(
    `Estimated input tokens: about ${estimateTokens(chars)} (characters / 4, a rough estimate)`,
  );
  console.log(
    `Embedding requests: ${batches} (batches of ${BATCH_SIZE}, ${PAUSE_MS / 1000}s apart); at most ${batches * 3} if every one is retried twice`,
  );
  console.log(
    emptyPages.length === 0
      ? "Pages without a passage: none"
      : `Pages without a passage: ${emptyPages.join("; ")}`,
  );
  if (print) {
    for (const p of all)
      console.log(`\n--- ${p.id} (page ${p.page}) ---\n${p.text}`);
  }
}

async function readSavedIndex(file: string): Promise<PassageIndex | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as PassageIndex;
  } catch {
    return null;
  }
}

async function embedAll(docs: Loaded[], file: string) {
  // The key stays in this process: it is read from .env.local and never printed.
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: the key may already be in the environment.
  }
  const { callEmbed, isAiConfigured } = await import("@/lib/ai/call");
  if (!isAiConfigured()) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set, so nothing was embedded.",
    );
  }

  const passages = docs.flatMap((d) => d.passages);
  const { id: model, dimensions } = EMBEDDING_MODEL;
  const saved = await readSavedIndex(file);
  const reusable = new Map<string, number[]>();
  if (saved && saved.model === model && saved.dimensions === dimensions) {
    for (const p of saved.passages) {
      if (p.embedding.length === dimensions) reusable.set(p.text, p.embedding);
    }
  }

  const done = new Map<string, number[]>();
  for (const p of passages) {
    const vector = reusable.get(p.text);
    if (vector) done.set(p.id, vector);
  }
  const todo = passages.filter((p) => !done.has(p.id));
  console.log(
    `${done.size} passages already embedded and reused; ${todo.length} to embed in ${Math.ceil(todo.length / BATCH_SIZE)} requests.`,
  );

  const save = (complete: boolean) => {
    const indexed: IndexedPassage[] = passages
      .filter((p) => done.has(p.id))
      .map((p) => ({ ...p, embedding: done.get(p.id)! }));
    const index: PassageIndex = {
      model,
      dimensions,
      taskType: "RETRIEVAL_DOCUMENT",
      normalized: true,
      complete,
      createdAt: new Date().toISOString(),
      passages: indexed,
    };
    return writeFile(file, `${JSON.stringify(index)}\n`);
  };

  let tokens = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(PAUSE_MS);
    try {
      const result = await callEmbed(
        { module: 3, feature: "build-index" },
        { values: batch.map((p) => p.text), taskType: "RETRIEVAL_DOCUMENT" },
      );
      tokens += result.tokens ?? 0;
      batch.forEach((p, n) => {
        done.set(
          p.id,
          normalize(result.embeddings[n]).map(
            (x) => Math.round(x * DECIMALS) / DECIMALS,
          ),
        );
      });
      await save(false);
    } catch (error) {
      await save(false);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Stopped after ${done.size} of ${passages.length} passages: ${message.slice(0, 300)}. Run it again to continue; finished passages are kept.`,
      );
    }
  }
  await save(true);

  const problems = checkIndex(
    JSON.parse(await readFile(file, "utf8")) as PassageIndex,
  );
  console.log(
    `Saved ${passages.length} passages to ${path.relative(process.cwd(), file)} (${tokens} input tokens reported).`,
  );
  console.log(
    problems.length === 0
      ? "Index check: ok"
      : `Index check found problems:\n${problems.join("\n")}`,
  );
}

export async function main(args: string[]) {
  const docs = await readDocuments();
  report(docs, args.includes("--print"));
  if (!args.includes("--embed")) {
    console.log("\nDry run: no model was called and no file was written.");
    return;
  }
  const outIndex = args.indexOf("--out");
  const file =
    outIndex === -1 ? PASSAGES_FILE : path.resolve(args[outIndex + 1]);
  await embedAll(docs, file);
}
