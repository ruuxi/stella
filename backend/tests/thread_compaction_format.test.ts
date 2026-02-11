import { describe, expect, test } from "bun:test";
import {
  findRecentStartIndex,
  findRecentStartIndexByTokens,
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
  test("backs up to the nearest user message to avoid split-turn starts", () => {
    const messages = [
      { role: "user", content: "task" },
      { role: "assistant", content: "thinking" },
      { role: "assistant", content: "tool call" },
      { role: "tool", content: "tool result" },
      { role: "assistant", content: "follow-up" },
      { role: "user", content: "next task" },
      { role: "assistant", content: "next reply" },
    ];

    const start = findRecentStartIndex(messages, 1);
    expect(start).toBe(5);
  });

  test("keeps recent messages by token budget and still starts at a user turn", () => {
    const messages = [
      { role: "user", content: "turn 1", tokenEstimate: 4000 },
      { role: "assistant", content: "response 1", tokenEstimate: 4000 },
      { role: "user", content: "turn 2", tokenEstimate: 4000 },
      { role: "assistant", content: "response 2", tokenEstimate: 4000 },
      { role: "user", content: "turn 3", tokenEstimate: 4000 },
      { role: "assistant", content: "response 3", tokenEstimate: 4000 },
    ];

    const start = findRecentStartIndexByTokens(messages, 9000);
    expect(start).toBe(4);
  });
});
