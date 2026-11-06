// The saved index of the customer documents: every passage with its embedding,
// in one JSON file (lib/copper/data/passages.json, made by `npm run
// index:build`). It's read once and kept in memory, so searching it never
// touches the disk or the model again.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Passage } from "@/lib/copper/rag/chunk";
import { lengthOf } from "@/lib/copper/rag/vectors";

export type IndexedPassage = Passage & { embedding: number[] };

export type PassageIndex = {
  model: string;
  dimensions: number;
  /** How the passages were embedded; questions must use RETRIEVAL_QUERY. */
  taskType: "RETRIEVAL_DOCUMENT";
  /** Every embedding has length 1, so a dot product is a cosine similarity. */
  normalized: true;
  /** False while a build is unfinished or stopped partway. */
  complete: boolean;
  createdAt: string;
  passages: IndexedPassage[];
};

export const PASSAGES_FILE = path.join(
  process.cwd(),
  "lib",
  "copper",
  "data",
  "passages.json",
);

const loaded = new Map<string, Promise<PassageIndex>>();

/** Problems with an index; empty when it is sound. */
export function checkIndex(index: PassageIndex): string[] {
  const problems: string[] = [];
  if (!index.complete) problems.push("The index is not complete.");
  const ids = new Set<string>();
  for (const p of index.passages) {
    if (ids.has(p.id)) problems.push(`Duplicate id ${p.id}.`);
    ids.add(p.id);
    if (!p.text.startsWith(`${p.title}\n`))
      problems.push(`${p.id}: text doesn't start with its title.`);
    if (!Number.isInteger(p.page) || p.page < 1)
      problems.push(`${p.id}: bad page ${p.page}.`);
    if (p.embedding.length !== index.dimensions)
      problems.push(
        `${p.id}: ${p.embedding.length} numbers, not ${index.dimensions}.`,
      );
    else if (!p.embedding.every(Number.isFinite))
      problems.push(`${p.id}: embedding has a value that isn't a number.`);
    else if (Math.abs(lengthOf(p.embedding) - 1) > 1e-3)
      problems.push(`${p.id}: embedding isn't length 1.`);
  }
  return problems;
}

/**
 * Loads the index once and keeps it in memory. Refuses an unusable one.
 * Without a file it is imported like the other data files (catalog.json), so
 * the deployed app always has it; a file path is for tests and scripts.
 */
export function loadPassages(file?: string): Promise<PassageIndex> {
  const key = file ?? "lib/copper/data/passages.json";
  let index = loaded.get(key);
  if (!index) {
    const read = file
      ? readFile(file, "utf8").then((json) => JSON.parse(json) as PassageIndex)
      : import("@/lib/copper/data/passages.json").then(
          (module) => module.default as unknown as PassageIndex,
        );
    index = read.then((parsed) => {
      const problems = checkIndex(parsed);
      if (problems.length > 0) {
        throw new Error(`${key} is not usable: ${problems[0]}`);
      }
      return parsed;
    });
    // A failed load isn't kept, so a later call can try again.
    index.catch(() => loaded.delete(key));
    loaded.set(key, index);
  }
  return index;
}
