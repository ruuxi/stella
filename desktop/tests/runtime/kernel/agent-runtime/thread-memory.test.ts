import { describe, expect, it } from "vitest";
import { buildStartupPromptMessages } from "../../../../../runtime/kernel/agent-runtime/thread-memory.js";

describe("buildStartupPromptMessages", () => {
  it("still injects memory snapshots on resumed orchestrator turns", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxTaskDepth: 1,
        threadHistory: [
          {
            role: "assistant",
            content: "Earlier reply",
          },
        ],
        memorySnapshot: {
          user: "USER PROFILE (who the user is)\nUser prefers concise replies",
          memory: "MEMORY (your personal notes)\nRemember to keep answers short",
        },
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.customType)).toEqual([
      "bootstrap.memory_snapshot",
      "bootstrap.memory_snapshot",
    ]);
    expect(messages[0]?.text).toContain('<memory_snapshot target="user">');
    expect(messages[0]?.text).toContain("User prefers concise replies");
    expect(messages[1]?.text).toContain('<memory_snapshot target="memory">');
    expect(messages[1]?.text).toContain("Remember to keep answers short");
  });
});
