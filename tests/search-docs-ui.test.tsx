// The search_docs tool card in the Ask Copper panel, offline: askCopper is
// replaced by a fake that returns a finished answer with a search result.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskCopper } from "@/components/copper/ask-copper";
import { createLive } from "@/lib/ai/live";
import type { Progress, Step } from "@/lib/copper/assistant/progress";

const askCopper = vi.hoisted(() => vi.fn());
vi.mock("@/lib/copper/assistant/ask", () => ({ askCopper }));

afterEach(() => {
  cleanup();
  askCopper.mockReset();
});

const hit = (
  id: string,
  title: string,
  file: string,
  page: number,
  text: string,
  score: number,
) => ({ id, title, page, link: `${file}#page=${page}`, text, score });

const RESULTS = [
  hit(
    "copper-home-user-guide-p9-1",
    "Copper Home User Guide",
    "/docs/copper-home-user-guide.pdf",
    9,
    "8 Troubleshooting and error codes\nC-47 Microphone array fault Unplug Copper Home for 30 seconds",
    0.83,
  ),
  hit(
    "copper-notes-user-guide-p8-1",
    "Copper Notes User Guide",
    "/docs/copper-notes-user-guide.pdf",
    8,
    "7 Troubleshooting and error codes\nC-12 Wi-Fi connection lost",
    0.8,
  ),
  hit(
    "a-3",
    "Copper Plus FAQ",
    "/docs/copper-plus-faq.pdf",
    3,
    "Refined answers",
    0.7,
  ),
  hit(
    "a-4",
    "Copper Plus FAQ",
    "/docs/copper-plus-faq.pdf",
    4,
    "Recording",
    0.69,
  ),
  hit(
    "a-5",
    "Copper State Labs Terms and Conditions",
    "/docs/copper-terms-and-conditions.pdf",
    3,
    "3. LIMITED WARRANTY",
    0.68,
  ),
];

function answering(reply: string, steps: Step[]) {
  const done = createLive<Progress>();
  done.done({ steps, reply, status: "done" });
  return { progress: done.live };
}

const searchStep = (output: unknown): Step => ({
  type: "tool",
  id: "call-1",
  name: "search_docs",
  state: "done",
  input: { query: "C-47" },
  output,
});

async function openAndAsk(question: string) {
  render(<AskCopper aiConfigured />);
  fireEvent.click(screen.getByTestId("ask-copper-launcher"));
  const chat = within(await screen.findByTestId("ask-copper"));
  fireEvent.change(chat.getByRole("textbox"), { target: { value: question } });
  fireEvent.click(chat.getByRole("button", { name: /send/i }));
  return chat;
}

describe("the search_docs tool card", () => {
  it("shows the query and every result with its document, page and a link to that page", async () => {
    askCopper.mockResolvedValue(
      answering(
        "C-47 is a microphone fault (Copper Home User Guide, page 9).",
        [searchStep({ status: "ok", query: "C-47", results: RESULTS })],
      ),
    );
    const chat = await openAndAsk("What does C-47 mean?");
    await waitFor(() =>
      expect(chat.getByText(/microphone fault \(/)).toBeInTheDocument(),
    );

    const card = chat.getByTestId("tool-call");
    expect(card.dataset.tool).toBe("search_docs");
    expect(within(card).getByText(/what copper sent/i)).toBeVisible();
    expect(within(card).getByText("C-47", { selector: "dd" })).toBeVisible();

    const items = within(card).getAllByTestId("doc-result");
    expect(items).toHaveLength(5);
    // The best match: its document, page and passage.
    expect(within(items[0]).getByText("Copper Home User Guide")).toBeVisible();
    expect(within(items[0]).getByText("page 9")).toBeVisible();
    expect(items[0].textContent).toContain("C-47 Microphone array fault");
    expect(items[0].textContent).toContain("similarity 0.83");

    // Each link opens that PDF at that page, in a new tab.
    const links = items.map((item) => within(item).getByRole("link"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/docs/copper-home-user-guide.pdf#page=9",
      "/docs/copper-notes-user-guide.pdf#page=8",
      "/docs/copper-plus-faq.pdf#page=3",
      "/docs/copper-plus-faq.pdf#page=4",
      "/docs/copper-terms-and-conditions.pdf#page=3",
    ]);
    expect(links[0]).toHaveAccessibleName("Open page 9");
    for (const a of links) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    // The card comes before Copper's reply.
    const reply = chat.getByText(/microphone fault \(/);
    expect(
      card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says plainly when the documents couldn't be searched", async () => {
    askCopper.mockResolvedValue(
      answering("I can't look that up right now.", [
        searchStep({
          status: "unavailable",
          message:
            "Searching the documents failed. Please try again in a moment.",
        }),
      ]),
    );
    const chat = await openAndAsk("What does C-47 mean?");
    await waitFor(() =>
      expect(chat.getByText(/can't look that up/)).toBeInTheDocument(),
    );
    const card = chat.getByTestId("tool-call");
    expect(
      within(card).getByText(/Searching the documents failed/),
    ).toBeVisible();
    expect(within(card).queryAllByTestId("doc-result")).toHaveLength(0);
  });
});

describe("Ask Copper keeps what it had", () => {
  it("lists search_docs next to the four tools Copper can use", async () => {
    askCopper.mockResolvedValue(answering("Hi!", []));
    const chat = await openAndAsk("Hello");
    await waitFor(() => expect(chat.getByText("Hi!")).toBeInTheDocument());
    for (const name of [
      "get_products",
      "get_prices",
      "calculate_cost",
      "check_availability",
      "search_docs",
    ]) {
      expect(chat.getByText(name)).toBeInTheDocument();
    }
  });

  it("offers a documents starter beside the three shopping ones", async () => {
    render(<AskCopper aiConfigured />);
    fireEvent.click(screen.getByTestId("ask-copper-launcher"));
    const chat = within(await screen.findByTestId("ask-copper"));
    for (const starter of [
      "How much is Copper Home with Copper Plus, paid yearly, for 2 years?",
      "Is Copper Notes in Night Sky in stock?",
      "Is Copper Plus cheaper monthly or yearly?",
      "What does error code C-47 mean?",
    ]) {
      expect(chat.getByRole("button", { name: starter })).toBeInTheDocument();
    }
  });

  it("still draws a price calculation as before", async () => {
    askCopper.mockResolvedValue(
      answering("That comes to $307.", [
        {
          type: "tool",
          id: "call-2",
          name: "calculate_cost",
          state: "done",
          input: {
            products: ["copper-home"],
            plan: "copper-plus",
            billing: "annual",
            years: 2,
          },
          output: { lines: [{ item: "Copper Home", usd: 149 }], totalUsd: 307 },
        },
      ]),
    );
    const chat = await openAndAsk("Total for Home with Plus?");
    await waitFor(() =>
      expect(chat.getByText(/comes to \$307/)).toBeInTheDocument(),
    );
    expect(
      within(chat.getByTestId("tool-call")).getByText("$307"),
    ).toBeVisible();
  });
});
