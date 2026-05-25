import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCodexExecArgs,
  buildCodexPromptFromMessages,
  fileChangesFromCodexItem,
  runCodexAgentTurn,
  shouldUseCodexAgentRuntime,
} from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import { DEFAULT_CODEX_MODEL } from "../../../../../runtime/kernel/preferences/local-preferences.js";

describe("Codex agent runtime", () => {
  it("only routes spawned general agents to Codex", () => {
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "general",
        agentEngine: "codex_cli",
      }),
    ).toBe(true);
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "orchestrator",
        agentEngine: "codex_cli",
      }),
    ).toBe(false);
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "general",
        agentEngine: "cursor_sdk",
      }),
    ).toBe(false);
  });

  it("builds a Codex prompt from Stella system and ordered prompt messages", () => {
    const prompt = buildCodexPromptFromMessages({
      systemPrompt: "You are Stella.",
      promptMessages: [
        {
          text: "hidden context",
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.test",
        },
        { text: "Do the work." },
      ],
    });

    expect(prompt).toContain("<stella_system_prompt>\nYou are Stella.");
    expect(prompt).toContain(
      '<message index="1" type="message" visibility="hidden" customType="runtime.test">',
    );
    expect(prompt).toContain('<message index="2" type="user" visibility="visible">');
  });

  it("passes Codex exec the model, cwd, resume id, and permissive local policy", () => {
    expect(
      buildCodexExecArgs({
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        persistedSessionId: "thread-1",
        imagePaths: ["/tmp/image.png"],
      }),
    ).toEqual([
      "exec",
      "--experimental-json",
      "--model",
      "gpt-5.5",
      "--sandbox",
      "danger-full-access",
      "--config",
      'approval_policy="never"',
      "--cd",
      "/repo",
      "resume",
      "thread-1",
      "--image",
      "/tmp/image.png",
    ]);
  });

  it("fails when the Codex executable cannot be started", async () => {
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    process.env.STELLA_CODEX_CLI_PATH = path.join(
      "/tmp",
      "missing-stella-codex-binary",
    );
    try {
      await expect(
        runCodexAgentTurn({
          runId: "run-missing-codex",
          sessionKey: "session-missing-codex",
          prompt: "hello",
        }),
      ).rejects.toThrow(/ENOENT|missing-stella-codex-binary/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
    }
  });

  it("normalizes Codex file_change items to Stella file changes", () => {
    const changes = fileChangesFromCodexItem(
      {
        id: "patch-1",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "src/new.ts", kind: "add" },
          { path: "/repo/src/existing.ts", kind: "update" },
        ],
      },
      "/repo",
    );

    expect(changes).toEqual([
      {
        path: path.resolve("/repo", "src/new.ts"),
        kind: { type: "add" },
      },
      {
        path: "/repo/src/existing.ts",
        kind: { type: "update" },
      },
    ]);
  });
});
