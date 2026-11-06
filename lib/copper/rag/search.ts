// search_docs: finds the passages of Copper's customer documents that best
// match a question. The question is embedded with the same model and size as
// the passages (but as a RETRIEVAL_QUERY), and each passage is scored by its
// dot product with it, which is their cosine similarity.
import { z } from "zod";
import { AiNotConfiguredError, callEmbed } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { loadPassages, type PassageIndex } from "@/lib/copper/rag/passages";
import { dot, normalize } from "@/lib/copper/rag/vectors";

/** How many passages a search returns. */
export const SEARCH_RESULTS = 5;

export const searchDocsInput = z.object({
  query: z.string().trim().min(1).max(500),
});

export type DocHit = {
  id: string;
  title: string;
  /** The page of the PDF the passage is on (1 is the first page). */
  page: number;
  /** Opens the PDF at that page. */
  link: string;
  /** The passage, without its title. */
  text: string;
  /** Cosine similarity to the question: higher is closer. */
  score: number;
};

export type DocSearch =
  | { status: "ok"; query: string; results: DocHit[] }
  | { status: "unavailable"; message: string };

/** A link that opens a PDF at one page (the browser's PDF viewer reads #page). */
export function pdfLink(file: string, page: number): string {
  return `${file}#page=${page}`;
}

const unavailable = (message: string): DocSearch => ({
  status: "unavailable",
  message,
});

/**
 * The passages closest to `query`, best first. Says so plainly, instead of
 * guessing, when the documents can't be searched.
 */
export async function searchDocs(
  query: string,
  {
    limit = SEARCH_RESULTS,
    index,
  }: { limit?: number; index?: PassageIndex } = {},
): Promise<DocSearch> {
  let saved: PassageIndex;
  try {
    saved = index ?? (await loadPassages());
  } catch {
    return unavailable("The documents can't be searched right now.");
  }
  // Vectors from different models or sizes can't be compared.
  if (
    saved.model !== EMBEDDING_MODEL.id ||
    saved.dimensions !== EMBEDDING_MODEL.dimensions
  ) {
    return unavailable(
      "The document index was built with a different embedding model, so it can't be searched until it is rebuilt.",
    );
  }

  let vector: number[];
  try {
    const { embeddings } = await callEmbed(
      { module: 3, feature: "search-docs" },
      { values: [query], taskType: "RETRIEVAL_QUERY" },
    );
    vector = normalize(embeddings[0]);
  } catch (error) {
    return unavailable(
      error instanceof AiNotConfiguredError
        ? "Searching the documents needs AI to be set up."
        : "Searching the documents failed. Please try again in a moment.",
    );
  }

  const results = saved.passages
    .map((p) => ({ p, score: dot(vector, p.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p, score }) => ({
      id: p.id,
      title: p.title,
      page: p.page,
      link: pdfLink(p.file, p.page),
      text: p.text.slice(p.title.length + 1),
      score: Math.round(score * 1000) / 1000,
    }));
  return { status: "ok", query, results };
}
