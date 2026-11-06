// Step 6 in the chat panel, offline: askCopper is replaced by a fake that
// returns a finished answer, so the test checks how the panel draws citations.
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
import { NOT_FOUND } from "@/lib/copper/assistant/instructions";
import type { Progress, Step } from "@/lib/copper/assistant/progress";

const askCopper = vi.hoisted(() => vi.fn());
vi.mock("@/lib/copper/assistant/ask", () => ({ askCopper }));

afterEach(() => {
  cleanup();
  askCopper.mockReset();
});

const hit = (title: string, file: string, page: number, text: string) => ({
  id: `${file}-${page}`,
  title,
  page,
  link: `${file}#page=${page}`,
  text,
  score: 0.7,
});

const HOME_9 = hit(
  "Copper Home User Guide",
  "/docs/copper-home-user-guide.pdf",
  9,
  "C-47 Microphone array fault Unplug Copper Home for 30 seconds",
);
const TERMS_4 = hit(
  "Copper State Labs Terms and Conditions",
  "/docs/copper-terms-and-conditions.pdf",
  4,
  "4.6 Refunds Annual Full refund if you cancel within 14 days of purchase",
);
const HOME_4 = hit(
  "Copper Home User Guide",
  "/docs/copper-home-user-guide.pdf",
  4,
  "3 Wi-Fi and connection",
);

const searched = (query: string, results: unknown[]): Step => ({
  type: "tool",
  id: "call-1",
  name: "search_docs",
  state: "done",
  input: { query },
  output: { status: "ok", query, results },
});

function answering(reply: string, steps: Step[]) {
  const done = createLive<Progress>();
  done.done({ steps, reply, status: "done" });
  return { progress: done.live };
}

async function openAndAsk(question: string) {
  render(<AskCopper aiConfigured />);
  fireEvent.click(screen.getByTestId("ask-copper-launcher"));
  const chat = within(await screen.findByTestId("ask-copper"));
  fireEvent.change(chat.getByRole("textbox"), { target: { value: question } });
  fireEvent.click(chat.getByRole("button", { name: /send/i }));
  return chat;
}

const cite = (h: { title: string; page: number; link: string }) =>
  `[${h.title}, p. ${h.page}](${h.link})`;

describe("citations in the chat panel", () => {
  it("draws each source as a link that opens that PDF page", async () => {
    askCopper.mockResolvedValue(
      answering(
        `C-47 is a microphone array fault ${cite(HOME_9)}. Unplug Copper Home for 30 seconds ${cite(HOME_9)}.`,
        [searched("C-47", [HOME_9, TERMS_4])],
      ),
    );
    const chat = await openAndAsk("What does error code C-47 mean?");
    await waitFor(() =>
      expect(chat.getByText(/is a microphone array fault/)).toBeInTheDocument(),
    );

    const links = chat.getAllByTestId("citation");
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a).toHaveTextContent("[Copper Home User Guide, p. 9]");
      expect(a).toHaveAttribute(
        "href",
        "/docs/copper-home-user-guide.pdf#page=9",
      );
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(chat.queryAllByTestId("citation-unverified")).toHaveLength(0);
    // The reply reads as sentences, not as raw Markdown.
    expect(chat.queryByText(/\]\(\/docs/)).toBeNull();
  });

  it("links each source to its own document and page", async () => {
    askCopper.mockResolvedValue(
      answering(
        `Annual plans get a full refund within 14 days ${cite(TERMS_4)}. Wi-Fi is set up in the app ${cite(HOME_4)}.`,
        [searched("annual refund", [TERMS_4, HOME_4])],
      ),
    );
    const chat = await openAndAsk("Annual refund? And Wi-Fi?");
    await waitFor(() =>
      expect(chat.getByText(/full refund within 14 days/)).toBeInTheDocument(),
    );
    expect(
      chat.getAllByTestId("citation").map((a) => a.getAttribute("href")),
    ).toEqual([
      "/docs/copper-terms-and-conditions.pdf#page=4",
      "/docs/copper-home-user-guide.pdf#page=4",
    ]);
  });

  it("does not make a link out of a source that wasn't retrieved, and flags it", async () => {
    askCopper.mockResolvedValue(
      answering(
        // Right title, but page 12 wasn't in the results; and a link to a stranger's site.
        `Copper Home has a 5-year warranty [Copper Home User Guide, p. 12](/docs/copper-home-user-guide.pdf#page=12). Buy more [Shop](https://example.com/buy).`,
        [searched("warranty", [HOME_9])],
      ),
    );
    const chat = await openAndAsk("How long is the warranty?");
    await waitFor(() =>
      expect(chat.getByText(/5-year warranty/)).toBeInTheDocument(),
    );
    expect(chat.queryAllByTestId("citation")).toHaveLength(0);
    // (The search card's own "Open page" links are real results, so only the
    // two bad citations are checked.)
    expect(chat.queryByRole("link", { name: /p\. 12/ })).toBeNull();
    expect(chat.queryByRole("link", { name: /Shop/ })).toBeNull();
    for (const a of chat.queryAllByRole("link")) {
      expect(a.getAttribute("href")).not.toMatch(/example\.com|page=12/);
    }
    const flagged = chat.getAllByTestId("citation-unverified");
    expect(flagged).toHaveLength(2);
    expect(flagged[0]).toHaveAttribute(
      "title",
      "This source wasn't in the search results",
    );
  });

  it("shows the not-found reply as plain text, with no links", async () => {
    askCopper.mockResolvedValue(
      answering(`${NOT_FOUND} Please contact the Copper Crew.`, [
        searched("order a pizza", [HOME_4]),
      ]),
    );
    const chat = await openAndAsk("Can Copper Home order me a pizza?");
    await waitFor(() =>
      expect(
        chat.getByText(
          "I couldn't find that in our support docs. Please contact the Copper Crew.",
        ),
      ).toBeInTheDocument(),
    );
    expect(chat.queryAllByTestId("citation")).toHaveLength(0);
    expect(chat.queryAllByTestId("citation-unverified")).toHaveLength(0);
  });

  it("still draws a reply with no sources as plain text", async () => {
    askCopper.mockResolvedValue(
      answering("Copper Home is $149.", [
        {
          type: "tool",
          id: "call-2",
          name: "get_prices",
          state: "done",
          input: {},
          output: { products: [], plans: [] },
        },
      ]),
    );
    const chat = await openAndAsk("How much is Copper Home?");
    await waitFor(() =>
      expect(chat.getByText("Copper Home is $149.")).toBeInTheDocument(),
    );
    expect(chat.queryAllByRole("link")).toHaveLength(0);
  });
});
