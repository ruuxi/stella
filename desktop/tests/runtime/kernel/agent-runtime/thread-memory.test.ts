import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  buildSubagentPromptMessages,
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
  it("can include the registry startup doc when explicitly enabled", async () => {
    const stellaHome = await mkdtemp(path.join(tmpdir(), "stella-registry-"));
    try {
      await writeFile(
        path.join(stellaHome, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
        },
        stellaHome,
        includeRegistry: true,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]?.customType).toBe("bootstrap.startup_doc");
      expect(messages[0]?.text).toContain('path="~/.stella/registry.md"');
      expect(messages[0]?.text).toContain("registry orientation");
    } finally {
      await rm(stellaHome, { recursive: true, force: true });
    }
  });

  it("omits the registry startup doc by default", async () => {
    const stellaHome = await mkdtemp(path.join(tmpdir(), "stella-registry-"));
    try {
      await writeFile(
        path.join(stellaHome, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
        },
        stellaHome,
      });

      expect(messages).toEqual([]);
    } finally {
      await rm(stellaHome, { recursive: true, force: true });
    }
  });

  it("does not assemble dynamic memory", async () => {
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
      },
    });

    expect(messages).toEqual([]);
  });
});

describe("buildSubagentPromptMessages", () => {
  it("omits the registry startup doc for General subagent prompts", async () => {
    const stellaHome = await mkdtemp(path.join(tmpdir(), "stella-general-"));
    try {
      await writeFile(
        path.join(stellaHome, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildSubagentPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
          coreMemory: "remembered user context",
        },
        stellaHome,
        agentType: AGENT_IDS.GENERAL,
        userPrompt: "Do the work.",
      });

      const promptText = messages.map((message) => message.text).join("\n");
      expect(promptText).not.toContain("Life Registry");
      expect(promptText).not.toContain('path="~/.stella/registry.md"');
      expect(promptText).toContain("remembered user context");
      expect(promptText).toContain("Do the work.");
    } finally {
      await rm(stellaHome, { recursive: true, force: true });
    }
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
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_summary.md">\nold summary\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "old user",
          timestamp: 2,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [
              {
                type: "text",
                text: '<memory_snapshot target="user">\nold user\n</memory_snapshot>',
              },
            ],
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
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_summary.md">\nnew summary\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "new memory",
          timestamp: 5,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [
              {
                type: "text",
                text: '<memory_snapshot target="user">\nnew memory\n</memory_snapshot>',
              },
            ],
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
