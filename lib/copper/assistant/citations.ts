// Source citations in Copper's replies. For setup, troubleshooting, warranty
// and policy answers, Copper ends each fact with a link such as
// [Copper Home User Guide, p. 9](/docs/copper-home-user-guide.pdf#page=9).
// A citation only counts when it matches a passage that search_docs really
// returned for this answer: same label and same link. Anything else is shown
// as plain text, flagged, and never as a link. Pure functions, so the chat
// panel (a client component) and the tests can share them.
import type { Step } from "@/lib/copper/assistant/progress";

/** A citation as the model writes it: [label](href). */
const CITATION = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** The label a passage is cited by, e.g. "Copper Home User Guide, p. 9". */
export function citationLabel(hit: { title: string; page: number }): string {
  return `${hit.title}, p. ${hit.page}`;
}

/** link -> label, for every passage search_docs returned in these steps. */
export function sourcesOf(steps: Step[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const step of steps) {
    if (step.type !== "tool" || step.name !== "search_docs") continue;
    const output = step.output as
      | {
          status?: string;
          results?: { title: string; page: number; link: string }[];
        }
      | undefined;
    if (output?.status !== "ok") continue;
    for (const hit of output.results ?? []) {
      sources.set(hit.link, citationLabel(hit));
    }
  }
  return sources;
}

export type ReplySegment =
  | { type: "text"; text: string }
  | {
      type: "citation";
      label: string;
      href: string;
      /** True when it matches a passage search_docs returned. */
      verified: boolean;
    };

/** A reply cut into plain text and citations, each checked against `sources`. */
export function splitReply(
  reply: string,
  sources: Map<string, string>,
): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let last = 0;
  for (const match of reply.matchAll(CITATION)) {
    const [whole, label, href] = match;
    if (match.index > last) {
      segments.push({ type: "text", text: reply.slice(last, match.index) });
    }
    const verified =
      sources.get(href)?.trim().toLowerCase() === label.trim().toLowerCase();
    segments.push({ type: "citation", label, href, verified });
    last = match.index + whole.length;
  }
  if (last < reply.length) {
    segments.push({ type: "text", text: reply.slice(last) });
  }
  return segments;
}

/** The citations in a reply, in order. */
export function citationsIn(reply: string) {
  return [...reply.matchAll(CITATION)].map(([, label, href]) => ({
    label,
    href,
  }));
}

/**
 * The sentences of a reply that carry no citation. A citation may sit before
 * or after the full stop. An empty list means every sentence is cited.
 */
export function sentencesWithoutCitation(reply: string): string[] {
  const marked = reply.replace(CITATION, "\u0001");
  const sentences: string[] = [];
  for (const part of marked
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    // A citation that starts its own sentence belongs to the one before.
    if (/^\u0001+[.!?]?$/.test(part) && sentences.length > 0) {
      sentences[sentences.length - 1] += part;
    } else {
      sentences.push(part);
    }
  }
  return sentences.filter((s) => !s.includes("\u0001"));
}
