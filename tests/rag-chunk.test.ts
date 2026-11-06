// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildPassages,
  chunkPage,
  cleanPage,
  headerTitleOf,
} from "@/lib/copper/rag/chunk";
import { DOCUMENTS } from "@/lib/copper/documents";
import { readPdfPages } from "@/lib/copper/rag/pdf";

const FAQ = DOCUMENTS.find((d) => d.id === "copper-plus-faq")!;

describe("cleanPage", () => {
  it("drops the repeated header but keeps the content", () => {
    const raw = [
      "Copper Plus FAQ Copper Help Center",
      "CSL-KB-0310 Help Center article Page 2 of 6",
      "© 2026 Copper State Labs, Inc. · Fictional company and documents.",
      "Q What is Copper Plus?",
      "An optional subscription.",
    ].join("\n");
    expect(cleanPage(raw, "Copper Plus FAQ")).toBe(
      "Q What is Copper Plus?\nAn optional subscription.",
    );
  });

  it("drops the cover page's masthead, and nothing else", () => {
    const raw =
      "COPPER STATE LABS\nCSL-UG-0101-EN Rev. C 1\n© 2026 Copper State Labs, Inc.\nUSER GUIDE";
    expect(cleanPage(raw, "Copper Home User Guide")).toBe("USER GUIDE");
  });

  it("keeps a first line that is real content", () => {
    expect(cleanPage("Free plan\nPaid plan", "Copper Plus FAQ")).toBe(
      "Free plan\nPaid plan",
    );
  });

  it("reads the section name from the header", () => {
    expect(
      headerTitleOf(
        "Copper Home User Guide Set up Copper Home\nrest",
        "Copper Home User Guide",
      ),
    ).toBe("Set up Copper Home");
  });
});

describe("chunkPage", () => {
  const returns = [
    "2. RETURNS",
    "2.1 You can return any device within 30 days.",
    "2.2 To start a return, contact the Copper Crew.",
    "2.3 Refunds go back to your original payment method.",
  ].join("\n");

  it("keeps a whole section that fits in one passage", () => {
    const passages = chunkPage(
      `1. PURCHASES\n1.1 Prices are in US dollars.\n${returns}`,
      {
        target: 120,
      },
    );
    const refunds = passages.filter((p) => p.includes("2.3 Refunds"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toContain("2.1 You can return");
    expect(refunds[0].startsWith("2. RETURNS")).toBe(true);
  });

  it("puts a heading on its own line with what follows it", () => {
    const [first] = chunkPage("2. RETURNS\n2.1 You can return any device.");
    expect(first).toBe("2. RETURNS\n2.1 You can return any device.");
  });

  it("repeats the section heading when a long section must be split", () => {
    const clause = (n: number) => `8.${n} ${"word ".repeat(30)}end.`;
    const body = [
      "8 Troubleshooting and error codes",
      ...[1, 2, 3, 4, 5].map(clause),
    ].join("\n");
    const passages = chunkPage(
      body,
      { target: 300, max: 400 },
      "Troubleshooting and error codes",
    );
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.startsWith("8 Troubleshooting and error codes")).toBe(
        true,
      );
    }
    // Nothing is lost or repeated except the headings.
    const clauses = passages.join("\n").match(/8\.\d /g);
    expect(clauses).toEqual(["8.1 ", "8.2 ", "8.3 ", "8.4 ", "8.5 "]);
  });

  it("keeps a table with the heading above it", () => {
    const body = [
      "8 Troubleshooting and error codes",
      "Code What it means What to do",
      "C-12 Wi-Fi connection lost Re-enter your Wi-Fi details",
      "C-47 Microphone fault Unplug it for 30 seconds",
    ].join("\n");
    const [only] = chunkPage(body, {}, "Troubleshooting and error codes");
    expect(only).toContain("C-12");
    expect(only).toContain("C-47");
  });

  it("does not mistake a numbered step for a section", () => {
    const body = [
      "2 Set up Copper Home",
      "1 Plug it in.",
      "2 Open the Copper app.",
      "3 Follow the prompts.",
    ].join("\n");
    expect(chunkPage(body, {}, "Set up Copper Home")).toEqual([body]);
  });

  it("packs short questions together up to the target", () => {
    const body = ["Q One?", "Yes.", "Q Two?", "No.", "Q Three?", "Maybe."].join(
      "\n",
    );
    expect(chunkPage(body, { target: 30 })).toEqual([
      "Q One?\nYes.\nQ Two?\nNo.",
      "Q Three?\nMaybe.",
    ]);
  });
});

describe("buildPassages", () => {
  const pages = [
    "Copper Plus FAQ Copper Help Center\nCSL-KB-0310 Page 1 of 2\n© 2026 Copper State Labs, Inc.\nQ A?\nYes.",
    "Copper Plus FAQ Copper Help Center\nCSL-KB-0310 Page 2 of 2\n© 2026 Copper State Labs, Inc.\nQ B?\nNo.",
  ];

  it("starts every passage with the document title and keeps its page", () => {
    const passages = buildPassages(FAQ, pages);
    expect(passages.map((p) => p.page)).toEqual([1, 2]);
    for (const p of passages) {
      expect(p.text.startsWith(`${FAQ.title}\n`)).toBe(true);
      expect(p.title).toBe(FAQ.title);
      expect(p.file).toBe(FAQ.file);
      expect(p.documentId).toBe(FAQ.id);
    }
    expect(passages[1].text).toBe(`${FAQ.title}\nQ B?\nNo.`);
  });

  it("gives every passage a stable, unique id", () => {
    const passages = buildPassages(FAQ, pages);
    expect(passages.map((p) => p.id)).toEqual([
      "copper-plus-faq-p1-1",
      "copper-plus-faq-p2-1",
    ]);
  });
});

// The real customer documents (offline: only reads the PDFs).
describe("the four customer PDFs", () => {
  async function load() {
    return Promise.all(
      DOCUMENTS.map(async (doc) => {
        const pages = await readPdfPages(`public${doc.file}`);
        return { doc, pages, passages: buildPassages(doc, pages) };
      }),
    );
  }

  it("have 32 pages, and every page produces at least one passage", async () => {
    const docs = await load();
    expect(docs.reduce((sum, d) => sum + d.pages.length, 0)).toBe(32);
    for (const { doc, pages, passages } of docs) {
      pages.forEach((_, i) => {
        expect(
          passages.some((p) => p.page === i + 1),
          `${doc.id} page ${i + 1}`,
        ).toBe(true);
      });
      for (const p of passages) {
        expect(p.page).toBeGreaterThanOrEqual(1);
        expect(p.page).toBeLessThanOrEqual(pages.length);
        // No page header or copyright line leaks into a passage.
        expect(p.text).not.toMatch(/©|CSL-[A-Z]+-\d/);
      }
    }
  });

  it("keep related information together", async () => {
    const all = (await load()).flatMap((d) => d.passages);
    const withText = (...parts: string[]) =>
      all.filter((p) => parts.every((part) => p.text.includes(part)));

    // Error codes and their fixes.
    for (const guide of ["copper-home-user-guide", "copper-notes-user-guide"]) {
      // The error-code table; other pages only mention C-12 in passing.
      const codes = all.filter(
        (p) =>
          p.documentId === guide &&
          p.text.includes("C-12") &&
          p.text.includes("What it means"),
      );
      expect(codes).toHaveLength(1);
      expect(codes[0].text).toContain("C-90");
    }
    expect(withText("C-47", "Microphone array fault")).toHaveLength(1);

    // Returns and refunds.
    expect(withText("2.1 You can return", "2.3 Refunds go back")).toHaveLength(
      1,
    );
    // The warranty.
    expect(withText("3.1 Warranty period", "3.5 How to claim")).toHaveLength(1);
    // Subscription refunds keep their heading.
    const subscription = withText("4.6 Refunds", "Annual");
    expect(subscription).toHaveLength(1);
    expect(subscription[0].text).toContain("4. COPPER PLUS SUBSCRIPTION");
  });

  it("have no duplicate ids and no oversized passage", async () => {
    const all = (await load()).flatMap((d) => d.passages);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) expect(p.text.length).toBeLessThan(1300);
  });
});
