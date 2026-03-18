import { describe, expect, test } from "bun:test";
import {
  findRecentStartIndexByTokens,
  findThreadCompactionCutByTokens,
  formatThreadMessagesForCompaction,
} from "../convex/data/thread_compaction_format";

describe("thread compaction formatting", () => {
  test("formats assistant tool calls and tool results from JSON content", () => {
    const output = formatThreadMessagesForCompaction([
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Trying to open Word." },
          { type: "tool-call", toolName: "Bash", args: { command: "start winword" } },
        ]),
      },
      {
        role: "tool",
        content: JSON.stringify([
          { type: "tool-result", toolName: "Bash", result: "OK" },
        ]),
      },
    ]);

    expect(output).toContain("[Assistant] Trying to open Word.");
    expect(output).toContain("[Assistant tool call] Bash(");
    expect(output).toContain("start winword");
    expect(output).toContain("[Tool result] Bash: OK");
  });

  test("falls back to raw content for non-JSON payloads", () => {
    const output = formatThreadMessagesForCompaction([
      { role: "assistant", content: "plain text response" },
    ]);
    expect(output).toContain("[Assistant] plain text response");
  });
});

describe("thread compaction split selection", () => {
  test("keeps recent messages by token budget and still starts at a user turn", () => {
    const messages = [
      { role: "user", content: "turn 1", tokenEstimate: 4000 },
      { role: "assistant", content: "response 1", tokenEstimate: 4000 },
      { role: "user", content: "turn 2", tokenEstimate: 4000 },
      { role: "assistant", content: "response 2", tokenEstimate: 4000 },
      { role: "user", content: "turn 3", tokenEstimate: 4000 },
      { role: "assistant", content: "response 3", tokenEstimate: 4000 },
    ];

    const cut = findRecentStartIndexByTokens(messages, 9000);
    expect(cut.recentStartIndex).toBe(4);
  });

  test("detects split-turn boundaries when token cut starts mid-turn", () => {
    const messages = [
      { role: "user", content: "task", tokenEstimate: 2000 },
      { role: "assistant", content: "analysis 1", tokenEstimate: 2000 },
      { role: "assistant", content: "analysis 2", tokenEstimate: 2000 },
      { role: "assistant", content: "latest", tokenEstimate: 2000 },
    ];

    const cut = findThreadCompactionCutByTokens(messages, 2500);
    expect(cut.recentStartIndex).toBe(3);
    expect(cut.isSplitTurn).toBe(true);
    expect(cut.turnStartIndex).toBe(0);
    expect(cut.historyEndIndex).toBe(0);
  });
});
