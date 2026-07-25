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

  it("tells every shell-capable agent that a long command wakes it on exit", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command", "apply_patch"],
    });

    expect(prompt).toContain("the runtime watches it for you");
    expect(prompt).toContain("you are resumed in this thread");
    // The coverage boundary is the whole point of saying it out loud.
    expect(prompt).toContain("nohup");
    expect(prompt).toContain("invisible to the runtime");
    // No WakeWhen in the allowlist, so don't advertise it.
    expect(prompt).not.toContain("`WakeWhen` covers waits");
  });

  it("mentions WakeWhen only when the agent has it, and only as the exception", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command", "WakeWhen"],
    });

    expect(prompt).toContain(
      "`WakeWhen` covers waits that are not a command exiting",
    );
    expect(prompt).toContain("only when process exit can't express the wait");
  });

  it("stays quiet for agents that cannot start anything long-running", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["Read", "Grep"],
    });

    expect(prompt).not.toContain("Long-running commands:");
  });
});

describe("buildStartupPromptMessages", () => {
  it("can include the registry startup doc when explicitly enabled", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(tmpdir(), "stella-registry-"),
    );
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
    const stellaDataDir = await mkdtemp(
      path.join(tmpdir(), "stella-registry-"),
    );
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

  it("push-injects the resident user profile and memory map as startup docs", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        userProfile: "# User Profile\n\n- The user goes by Bob",
        memoryMap:
          "# Memory map\n\n- resident-memory rewire -> MEMORY.md 2026-07-18",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/memories/profile.md"');
    expect(promptText).toContain("The user goes by Bob");
    expect(promptText).toContain('path="~/.stella/memories/memory_map.md"');
    expect(promptText).toContain("resident-memory rewire");
    expect(
      messages.every((m) => m.customType === "bootstrap.startup_doc"),
    ).toBe(true);
  });

  it("suppresses map injection while a retired doc's pinned copy is still persisted", async () => {
    // Pre-migration thread mid-epoch: the frozen memory_summary copy still
    // carries the routing content, so injecting the map too would duplicate
    // it for the rest of the epoch AND leave the retired copy pinned. The
    // boundary refresh converts the retired copy into the map copy instead.
    for (const retiredPath of [
      "~/.stella/memories/memory_summary.md",
      "~/.stella/memories/memory_index.md",
    ]) {
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
                    text: `<startup_doc path="${retiredPath}">\n# Retired doc\n\n- frozen content\n</startup_doc>`,
                  },
                ],
              },
            },
          ],
          memoryMap: "# Memory map\n\n- entry -> MEMORY.md 2026-07-18",
        },
      });
      expect(messages).toEqual([]);
    }
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

  it("does NOT re-inject a resident doc whose content changed mid-epoch (cache stability)", async () => {
    // Remember replaced the fact after the old doc was persisted. The pinned
    // copy must stay byte-frozen until the next compaction boundary: the new
    // fact is already visible in the window as the Remember call/result, and
    // appending another full copy is the stale-copy leak. The pinned copy
    // catches up from disk when compaction rebuilds the prefix.
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
        userProfile: "# User Profile\n\n- The user goes by Robert",
      },
    });

    expect(messages).toEqual([]);
  });

  it("keeps the injected prompt byte-stable across repeated mid-epoch rewrites", async () => {
    const persistedHistory = [
      {
        role: "runtimeInternal",
        content: "",
        customMessage: {
          customType: "bootstrap.startup_doc",
          content: [
            {
              type: "text",
              text: '<startup_doc path="~/.stella/memories/memory_map.md">\n# Memory map\n\n- v1 of the routing map\n</startup_doc>',
            },
          ],
        },
      },
    ];
    // Dream rewrites the map repeatedly within one epoch; every build
    // must contribute zero new messages so the persisted prefix stays
    // byte-identical between compactions.
    for (const rewrite of ["v2", "v3", "v4"]) {
      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: persistedHistory,
          memoryMap: `# Memory map\n\n- ${rewrite} of the routing map`,
        },
      });
      expect(messages).toEqual([]);
    }
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
