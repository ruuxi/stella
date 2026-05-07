import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildHistorySource,
  buildStartupPromptMessages,
} from "../../../../../runtime/kernel/agent-runtime/thread-memory.js";

describe("buildSystemPrompt", () => {
  it("adds structured file-editing guidance when apply_patch is available", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command", "apply_patch"],
    });

    expect(prompt).toContain("Prefer `apply_patch`");
    expect(prompt).toContain("Do not use shell heredocs");
    expect(prompt).toContain("standard POSIX shell commands");
  });

  it("omits file-editing guidance when apply_patch is unavailable", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command"],
    });

    expect(prompt).not.toContain("Prefer `apply_patch`");
    expect(prompt).toContain("standard POSIX shell commands");
  });
});

describe("buildStartupPromptMessages", () => {
  it("injects memory snapshots when the runner marks the turn for re-injection", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
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
        shouldInjectDynamicMemory: true,
      },
      includeDreamMemoryFiles: true,
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

  it("skips memory snapshots on coast turns (every-N-turn cadence)", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
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
        // shouldInjectDynamicMemory left undefined - this is a coast turn.
      },
      includeDreamMemoryFiles: true,
    });

    expect(messages).toEqual([]);
  });
});

describe("buildHistorySource", () => {
  // Retaining older bootstrap entries keeps the prompt-cache prefix stable.
  it("retains all persisted memory bundle entries in chronological order", () => {
    const history = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [
        {
          role: "runtimeInternal",
          content: "old summary",
          timestamp: 1,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [{
              type: "text",
              text: '<memory_file path="state/memories/memory_summary.md">\nold summary\n</memory_file>',
            }],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "old user",
          timestamp: 2,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [{
              type: "text",
              text: '<memory_snapshot target="user">\nold user\n</memory_snapshot>',
            }],
            display: false,
          },
        },
        {
          role: "user",
          content: "hello",
          timestamp: 3,
        },
        {
          role: "runtimeInternal",
          content: "new summary",
          timestamp: 4,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [{
              type: "text",
              text: '<memory_file path="state/memories/memory_summary.md">\nnew summary\n</memory_file>',
            }],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "new memory",
          timestamp: 5,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [{
              type: "text",
              text: '<memory_snapshot target="user">\nnew memory\n</memory_snapshot>',
            }],
            display: false,
          },
        },
      ],
    });

    const replayedText = history
      .map((message) => {
        if (typeof message.content === "string") {
          return message.content;
        }
        return message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
      })
      .join("\n");

    expect(replayedText).toContain("old summary");
    expect(replayedText).toContain("old user");
    expect(replayedText).toContain("new summary");
    expect(replayedText).toContain("new memory");

    expect(replayedText.indexOf("old summary")).toBeLessThan(
      replayedText.indexOf("new summary"),
    );
    expect(replayedText.indexOf("old user")).toBeLessThan(
      replayedText.indexOf("new memory"),
    );
  });
});
