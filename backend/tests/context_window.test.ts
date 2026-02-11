import { describe, expect, test } from "bun:test";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "../convex/agent/context_window";

describe("context window selection", () => {
  test("selects newest items within token budget", () => {
    const items = [
      { id: "d", tokens: 4000 },
      { id: "c", tokens: 3000 },
      { id: "b", tokens: 2000 },
      { id: "a", tokens: 1000 },
    ];

    const selected = selectRecentByTokenBudget({
      itemsNewestFirst: items,
      maxTokens: 5500,
      maxItems: 10,
      estimateTokens: (item) => item.tokens,
    });

    expect(selected.map((item) => item.id)).toEqual(["d"]);
  });

  test("always keeps at least one recent item when available", () => {
    const selected = selectRecentByTokenBudget({
      itemsNewestFirst: [{ id: "only", tokens: 9000 }],
      maxTokens: 100,
      maxItems: 5,
      estimateTokens: (item) => item.tokens,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe("only");
  });
});

describe("context event token estimation", () => {
  test("assigns non-trivial token weight to tool events", () => {
    const toolCallTokens = estimateContextEventTokens({
      type: "tool_request",
      payload: {
        toolName: "Bash",
        args: { command: "start winword" },
      },
    });

    const userTokens = estimateContextEventTokens({
      type: "user_message",
      payload: {
        text: "open word",
      },
    });

    expect(toolCallTokens).toBeGreaterThan(userTokens);
    expect(toolCallTokens).toBeGreaterThan(8);
  });
});
