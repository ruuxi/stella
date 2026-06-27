import { describe, expect, it } from "vitest";
import { deriveTurnWebSearchResults } from "../../../src/features/chat/lib/derive-turn-web-search";
import type { EventRecord } from "../../../src/features/chat/lib/event-transforms";

const event = (
  partial: Partial<EventRecord> &
    Pick<EventRecord, "_id" | "type" | "timestamp">,
): EventRecord => ({
  payload: {},
  ...partial,
});

const webResult = (
  agentType: string | undefined,
): EventRecord =>
  event({
    _id: `r-${agentType ?? "default"}`,
    type: "tool_result",
    timestamp: 1,
    payload: {
      toolName: "web",
      mode: "search",
      ...(agentType ? { agentType } : {}),
      results: [
        {
          title: "Example",
          url: "https://example.com/a",
          snippet: "…",
          image: "https://cdn.example.com/a.jpg",
          favicon: "https://example.com/favicon.ico",
        },
      ],
    },
  });

describe("deriveTurnWebSearchResults", () => {
  it("returns [] for empty turns", () => {
    expect(deriveTurnWebSearchResults([])).toEqual([]);
  });

  it("surfaces image-bearing hits when the orchestrator ran the search", () => {
    expect(deriveTurnWebSearchResults([webResult("orchestrator")])).toEqual([
      {
        title: "Example",
        url: "https://example.com/a",
        image: "https://cdn.example.com/a.jpg",
        favicon: "https://example.com/favicon.ico",
      },
    ]);
  });

  it("treats an absent agentType as the orchestrator", () => {
    expect(deriveTurnWebSearchResults([webResult(undefined)])).toHaveLength(1);
  });

  it("does NOT surface inline images for the general agent", () => {
    expect(deriveTurnWebSearchResults([webResult("general")])).toEqual([]);
  });

  it("does NOT surface inline images for other sub-agents", () => {
    expect(deriveTurnWebSearchResults([webResult("schedule")])).toEqual([]);
  });
});
