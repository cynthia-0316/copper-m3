// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkIndex,
  loadPassages,
  type PassageIndex,
} from "@/lib/copper/rag/passages";
import { DOCUMENTS } from "@/lib/copper/documents";
import { buildPassages } from "@/lib/copper/rag/chunk";
import { readPdfPages } from "@/lib/copper/rag/pdf";
import { dot, lengthOf, normalize } from "@/lib/copper/rag/vectors";
import { tempDir } from "./helpers/temp-dir";

function index(overrides: Partial<PassageIndex> = {}): PassageIndex {
  return {
    model: "google/gemini-embedding-001",
    dimensions: 3,
    taskType: "RETRIEVAL_DOCUMENT",
    normalized: true,
    complete: true,
    createdAt: "2026-11-05T00:00:00.000Z",
    passages: [
      {
        id: "doc-p1-1",
        documentId: "doc",
        title: "Doc",
        file: "/docs/doc.pdf",
        page: 1,
        text: "Doc\nHello",
        embedding: [1, 0, 0],
      },
    ],
    ...overrides,
  };
}

describe("vectors", () => {
  it("scales a vector to length 1", () => {
    const v = normalize([3, 4, 0]);
    expect(v).toEqual([0.6, 0.8, 0]);
    expect(lengthOf(v)).toBeCloseTo(1, 10);
  });

  it("makes the dot product the cosine similarity", () => {
    expect(dot(normalize([1, 1, 0]), normalize([1, 0, 0]))).toBeCloseTo(
      Math.SQRT1_2,
      10,
    );
  });

  it("refuses a vector it can't scale", () => {
    expect(() => normalize([0, 0, 0])).toThrow();
    expect(() => normalize([Number.NaN, 1])).toThrow();
    expect(() => dot([1], [1, 2])).toThrow();
  });
});

describe("checkIndex", () => {
  it("accepts a sound index", () => {
    expect(checkIndex(index())).toEqual([]);
  });

  it("reports an unfinished index", () => {
    expect(checkIndex(index({ complete: false }))[0]).toMatch(/not complete/);
  });

  it("reports a passage that doesn't start with its title", () => {
    const bad = index();
    bad.passages[0].text = "Hello";
    expect(checkIndex(bad)[0]).toMatch(/title/);
  });

  it("reports a wrong size, a bad number and a vector that isn't length 1", () => {
    for (const embedding of [
      [1, 0],
      [Number.NaN, 0, 0],
      [1, 1, 1],
    ]) {
      const bad = index();
      bad.passages[0].embedding = embedding;
      expect(checkIndex(bad)).toHaveLength(1);
    }
  });

  it("reports duplicate ids and bad pages", () => {
    const bad = index();
    bad.passages.push({ ...bad.passages[0], page: 0 });
    expect(checkIndex(bad).join(" ")).toMatch(/Duplicate id/);
    expect(checkIndex(bad).join(" ")).toMatch(/bad page/);
  });
});

describe("loadPassages", () => {
  it("loads the file once and keeps it in memory", async () => {
    const file = join(tempDir("passages-"), "passages.json");
    writeFileSync(file, JSON.stringify(index()));
    const first = await loadPassages(file);
    writeFileSync(file, JSON.stringify(index({ dimensions: 99 })));
    expect(await loadPassages(file)).toBe(first);
  });

  it("refuses an unfinished index, and lets a later call try again", async () => {
    const file = join(tempDir("passages-"), "passages.json");
    writeFileSync(file, JSON.stringify(index({ complete: false })));
    await expect(loadPassages(file)).rejects.toThrow(/not usable/);
    writeFileSync(file, JSON.stringify(index()));
    expect((await loadPassages(file)).passages).toHaveLength(1);
  });
});

// The index saved by `npm run index:build -- --embed` (offline: only reads it).
describe("the saved index (lib/copper/data/passages.json)", () => {
  it("is complete, valid and the size Gemini was asked for", async () => {
    const saved = await loadPassages();
    expect(checkIndex(saved)).toEqual([]);
    expect(saved.model).toBe("google/gemini-embedding-001");
    expect(saved.dimensions).toBe(768);
    expect(saved.taskType).toBe("RETRIEVAL_DOCUMENT");
  });

  it("matches the PDFs as they are split now", async () => {
    // If this fails, a PDF or the splitting rules changed: run
    // `npm run index:build -- --embed` again (it reuses what hasn't changed).
    const saved = await loadPassages();
    const current = (
      await Promise.all(
        DOCUMENTS.map(async (doc) =>
          buildPassages(doc, await readPdfPages(`public${doc.file}`)),
        ),
      )
    ).flat();
    // The saved passages are the current ones plus their embeddings.
    const withoutEmbeddings = saved.passages.map((p) => ({
      id: p.id,
      documentId: p.documentId,
      title: p.title,
      file: p.file,
      page: p.page,
      text: p.text,
    }));
    expect(withoutEmbeddings).toEqual(current);
  });
});
