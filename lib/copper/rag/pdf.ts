// Reads a PDF's text one page at a time, so every passage can keep the page it
// came from. Runs on the server only (the index script and tests), never in the
// browser.
import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

/** The text of each page, in order: index 0 is page 1. */
export async function readPdfPages(file: string): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}
