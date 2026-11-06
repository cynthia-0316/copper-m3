// Splits each page of a customer document into passages of a few sentences,
// without ever splitting one thing that belongs together: a clause, a question
// with its answer, a table with its heading (error codes, refund rules). A
// passage never crosses a page, so the page number stays accurate.
import type { CopperDocument } from "@/lib/copper/documents";

export type Passage = {
  /** Stable: the document, the page and the passage's place on that page. */
  id: string;
  documentId: string;
  title: string;
  /** The PDF's path under public/. */
  file: string;
  /** 1-based page of the PDF the text came from. */
  page: number;
  /** Starts with the document title, then the passage. */
  text: string;
};

export type ChunkOptions = {
  /** Stop adding to a passage once it reaches about this many characters. */
  target?: number;
  /** A whole section up to this long stays in one passage; longer is split. */
  max?: number;
};

const TARGET = 650;
const MAX = 1100;

const COPYRIGHT = /^©\s*\d{4}\s+Copper State Labs/;
const DOCUMENT_CODE = /^CSL-[A-Z]+-\d+/;
// A numbered clause or heading ("3.1 Warranty period.", "5 Lights ...", "1.
// PURCHASES") or an FAQ question ("Q What is Copper Plus?"). Requiring a
// capital after the number keeps a wrapped line like "30 days" in its paragraph.
const STARTS_PIECE = /^(?:\d+\.\d+\.?\s+[A-Z]|\d+\.?\s+[A-Z]|Q\s+\S)/;
// A section: "2. RETURNS" (the terms) or "8 Troubleshooting and error codes"
// (the guides). In the guides a step also starts with a number ("5 Name the
// room"), so a guide's heading is told apart by matching the section name
// printed in that page's header.
const NUMBERED_SECTION = /^\d+\.\s+[A-Z]/;
const GUIDE_SECTION = /^\d+\s+(.+)$/;

function isSectionHeading(piece: string, headerTitle: string): boolean {
  const first = piece.split("\n")[0].trim();
  if (NUMBERED_SECTION.test(first)) return true;
  const name = GUIDE_SECTION.exec(first)?.[1];
  return Boolean(
    name && headerTitle && name.toLowerCase() === headerTitle.toLowerCase(),
  );
}

/** The section name in a page's header, once the document title is removed. */
export function headerTitleOf(raw: string, title: string): string {
  const first = raw.split(/\r?\n/)[0]?.trim() ?? "";
  return first.toLowerCase().startsWith(title.toLowerCase())
    ? first.slice(title.length).trim()
    : "";
}

/**
 * Removes the header every page repeats (the running title, the document code
 * and page number, the copyright line), so passages hold only content.
 */
export function cleanPage(raw: string, title: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd());
  const first = lines[0]?.trim().toLowerCase() ?? "";
  const hasRunningHeader =
    first === "copper state labs" || first.startsWith(title.toLowerCase());
  return lines
    .slice(hasRunningHeader ? 1 : 0)
    .filter((line) => !COPYRIGHT.test(line) && !DOCUMENT_CODE.test(line))
    .join("\n")
    .trim();
}

/** Splits page text where a clause, heading or question begins. */
function splitPieces(body: string): string[] {
  const pieces: string[][] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    if (STARTS_PIECE.test(line) || pieces.length === 0) pieces.push([line]);
    else pieces[pieces.length - 1].push(line);
  }
  const joined = pieces.map((lines) => lines.join("\n"));
  // A heading on its own line ("2. RETURNS") belongs with what follows it.
  for (let i = 0; i < joined.length - 1; i++) {
    const piece = joined[i];
    if (!piece.includes("\n") && piece.length <= 70 && !/[.!?]$/.test(piece)) {
      joined[i + 1] = `${piece}\n${joined[i + 1]}`;
      joined[i] = "";
    }
  }
  return joined.filter(Boolean);
}

/** Splits one over-long piece by line, repeating its first line (the heading). */
function splitLong(piece: string, target: number): string[] {
  const [heading, ...rest] = piece.split("\n");
  const parts: string[] = [];
  let current = heading;
  for (const line of rest) {
    if (current.length + 1 + line.length > target && current !== heading) {
      parts.push(current);
      current = heading;
    }
    current += `\n${line}`;
  }
  parts.push(current);
  return parts;
}

/** Text that may be packed with its neighbors, or must stand alone. */
type Unit = { text: string; alone: boolean };

/**
 * Turns pieces into units. A section (a heading and everything under it) that
 * fits in `max` is one unit, so a warranty or returns policy is never torn
 * apart. A longer section is split into several units, each starting with the
 * section's heading so no passage loses its context.
 */
function toUnits(
  pieces: string[],
  target: number,
  max: number,
  headerTitle: string,
): Unit[] {
  const units: Unit[] = [];
  const heading = (piece: string) => isSectionHeading(piece, headerTitle);
  let i = 0;
  while (i < pieces.length) {
    if (!heading(pieces[i])) {
      units.push({ text: pieces[i], alone: false });
      i++;
      continue;
    }
    const section = [pieces[i++]];
    while (i < pieces.length && !heading(pieces[i])) {
      section.push(pieces[i++]);
    }
    const text = section.join("\n");
    if (text.length <= max) {
      units.push({ text, alone: text.length > target });
      continue;
    }
    const title = section[0].split("\n")[0];
    let current = "";
    for (const piece of section.flatMap((p) =>
      p.length > max ? splitLong(p, target) : [p],
    )) {
      if (current && current.length + 1 + piece.length > target) {
        units.push({ text: current, alone: true });
        current = "";
      }
      const start = piece.startsWith(title) ? piece : `${title}\n${piece}`;
      current = current ? `${current}\n${piece}` : start;
    }
    if (current) units.push({ text: current, alone: true });
  }
  return units;
}

/** One page's body as passages (without the title yet). */
export function chunkPage(
  body: string,
  { target = TARGET, max = MAX }: ChunkOptions = {},
  headerTitle = "",
): string[] {
  const passages: string[] = [];
  let current: Unit | null = null;
  for (const unit of toUnits(splitPieces(body), target, max, headerTitle)) {
    if (
      current &&
      !current.alone &&
      !unit.alone &&
      current.text.length + 1 + unit.text.length <= target
    ) {
      current = { text: `${current.text}\n${unit.text}`, alone: false };
      continue;
    }
    if (current) passages.push(current.text);
    current = unit;
  }
  if (current) passages.push(current.text);
  return passages;
}

/** Every passage of one document, given the text of each of its pages. */
export function buildPassages(
  doc: CopperDocument,
  pages: string[],
  options?: ChunkOptions,
): Passage[] {
  return pages.flatMap((raw, index) => {
    const page = index + 1;
    const passages = chunkPage(
      cleanPage(raw, doc.title),
      options,
      headerTitleOf(raw, doc.title),
    );
    return passages.map((body, n) => ({
      id: `${doc.id}-p${page}-${n + 1}`,
      documentId: doc.id,
      title: doc.title,
      file: doc.file,
      page,
      text: `${doc.title}\n${body}`,
    }));
  });
}
