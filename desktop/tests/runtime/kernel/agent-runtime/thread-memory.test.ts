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
import { buildDefaultTransformContext } from "../../../../../runtime/kernel/agent-runtime/shared.js";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";

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
    const stellaDataDir = await mkdtemp(path.join(tmpdir(), "stella-registry-"));
    try {
      await writeFile(
        path.join(stellaDataDir, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
        },
        stellaDataDir,
        includeRegistry: true,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]?.customType).toBe("bootstrap.startup_doc");
      expect(messages[0]?.text).toContain('path="~/.stella/registry.md"');
      expect(messages[0]?.text).toContain("registry orientation");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("omits the registry startup doc by default", async () => {
    const stellaDataDir = await mkdtemp(path.join(tmpdir(), "stella-registry-"));
    try {
      await writeFile(
        path.join(stellaDataDir, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
        },
        stellaDataDir,
      });

      expect(messages).toEqual([]);
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets from core memory startup docs", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        coreMemory: "OPENAI_API_KEY=sk-testsecret12345678901234567890",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).not.toContain("sk-testsecret12345678901234567890");
    expect(promptText).toContain("OPENAI_API_KEY=");
    expect(promptText).toContain("***");
  });

  it("push-injects the resident user profile and focus summary as startup docs", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        userProfile: "# User Profile\n\n- The user goes by Bob",
        memorySummary: "# Memory summary\n\n- Shipping the resident-memory rewire",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/memories/profile.md"');
    expect(promptText).toContain("The user goes by Bob");
    expect(promptText).toContain('path="~/.stella/memories/memory_summary.md"');
    expect(promptText).toContain("resident-memory rewire");
    expect(messages.every((m) => m.customType === "bootstrap.startup_doc")).toBe(
      true,
    );
  });

  it("does not re-inject resident docs already persisted in thread history", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "",
            customMessage: {
              customType: "bootstrap.startup_doc",
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/memories/profile.md">\n# User Profile\n\n- The user goes by Bob\n</startup_doc>',
                },
              ],
            },
          },
        ],
        userProfile: "# User Profile\n\n- The user goes by Bob",
      },
    });

    expect(messages).toEqual([]);
  });

  it("re-injects a resident doc whose content changed since it was persisted", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "",
            customMessage: {
              customType: "bootstrap.startup_doc",
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/memories/profile.md">\n# User Profile\n\n- The user goes by Bob\n</startup_doc>',
                },
              ],
            },
          },
        ],
        // Remember replaced the fact after the old doc was persisted.
        userProfile: "# User Profile\n\n- The user goes by Robert",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/memories/profile.md"');
    expect(promptText).toContain("The user goes by Robert");
    expect(promptText).not.toContain("The user goes by Bob");
  });

  it("injects personality as a startup doc ahead of core memory on the first turn", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        personality: "# Voice\nWarm and concise.",
        coreMemory: "remembered user context",
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.customType).toBe("bootstrap.startup_doc");
    expect(messages[0]?.text).toContain('path="~/.stella/PERSONALITY.md"');
    expect(messages[0]?.text).toContain("Warm and concise.");
    expect(messages[1]?.text).toContain('path="~/.stella/core-memory.md"');
  });

  it("injects startup docs into existing threads that do not have them yet", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [{ role: "assistant", content: "Earlier reply" }],
        personality: "# Voice\nWarm and concise.",
        coreMemory: "remembered user context",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/PERSONALITY.md"');
    expect(promptText).toContain('path="~/.stella/core-memory.md"');
  });

  it("omits startup docs that are already persisted in thread history", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "startup docs",
            customMessage: {
              customType: "bootstrap.startup_doc",
              display: false,
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/PERSONALITY.md">\n# Voice\nWarm and concise.\n</startup_doc>',
                },
              ],
            },
          },
        ],
        personality: "# Voice\nWarm and concise.",
      },
    });

    expect(messages).toEqual([]);
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
    const stellaDataDir = await mkdtemp(path.join(tmpdir(), "stella-general-"));
    try {
      await writeFile(
        path.join(stellaDataDir, "registry.md"),
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
        stellaDataDir,
        agentType: AGENT_IDS.GENERAL,
        userPrompt: "Do the work.",
      });

      const promptText = messages.map((message) => message.text).join("\n");
      expect(promptText).not.toContain("Life Registry");
      expect(promptText).not.toContain('path="~/.stella/registry.md"');
      expect(promptText).toContain("remembered user context");
      expect(promptText).toContain("Do the work.");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
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

describe("buildDefaultTransformContext", () => {
  it("preserves bootstrap startup docs when pruning oversized context", async () => {
    const transform = buildDefaultTransformContext({
      model: { contextWindow: 20_000 },
    } as Parameters<typeof buildDefaultTransformContext>[0]);
    const personality: AgentMessage = {
      role: "runtimeInternal",
      content: [
        {
          type: "text",
          text: '<startup_doc path="~/.stella/PERSONALITY.md">\nWarm and concise.\n</startup_doc>',
        },
      ],
      timestamp: 1,
      customType: "bootstrap.startup_doc",
    };
    const oldContext: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "old context ".repeat(20_000) }],
      timestamp: 2,
    };
    const currentPrompt: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "current user prompt" }],
      timestamp: 3,
    };

    const pruned = await transform([personality, oldContext, currentPrompt]);
    const prunedText = pruned
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map((block) =>
              block.type === "text" ? block.text : "",
            )
          : [message.content],
      )
      .join("\n");

    expect(pruned).toContain(personality);
    expect(prunedText).toContain("Warm and concise.");
    expect(prunedText).toContain("current user prompt");
  });
});
