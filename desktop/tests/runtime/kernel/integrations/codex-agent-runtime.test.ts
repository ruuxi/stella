import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  buildCodexUserInput,
  buildCodexPromptFromMessages,
  codexImagePathFromFileUrl,
  fileChangesFromCodexItem,
  getCodexRuntimePreferences,
  runCodexAgentTurn,
  shouldUseCodexAgentRuntime,
} from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import {
  DEFAULT_CODEX_MODEL,
  updateLocalModelPreferences,
} from "../../../../../runtime/kernel/preferences/local-preferences.js";

describe("Codex agent runtime", () => {
  it("routes every spawned agent type to Codex when the shared engine is selected", () => {
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "general",
        agentEngine: "codex_cli",
      }),
    ).toBe(true);
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "install_update",
        agentEngine: "codex_cli",
      }),
    ).toBe(true);
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

  it("starts Codex app-server threads with Stella tools and read-only native writes", () => {
    expect(
      buildCodexThreadStartParams({
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        tools: [
          {
            name: "exec_command",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
      }),
    ).toEqual({
      model: DEFAULT_CODEX_MODEL,
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "Stella",
      ephemeral: false,
      dynamicTools: [
        {
          name: "exec_command",
          description: "Run a command",
          inputSchema: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
  });

  it("passes model, cwd, and reasoning effort through turn/start", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        reasoningEffort: "high",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/repo",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
      model: DEFAULT_CODEX_MODEL,
      effort: "high",
    });
  });

  it("uses the Codex mini model for agents that default to Stella Light", () => {
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    try {
      expect(
        getCodexRuntimePreferences(undefined, "stella/light").model,
      ).toBe("gpt-5.4-mini");
      expect(
        getCodexRuntimePreferences(undefined, "stella/standard").model,
      ).toBe(DEFAULT_CODEX_MODEL);
    } finally {
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("keeps an explicit Codex model preference for Stella Light agents", () => {
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    const stellaHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-light-model-"),
    );
    try {
      updateLocalModelPreferences(stellaHome, {
        codexModel: "gpt-5.5",
      });
      expect(getCodexRuntimePreferences(stellaHome, "stella/light").model).toBe(
        "gpt-5.4-mini",
      );
      updateLocalModelPreferences(stellaHome, {
        codexModel: "custom-codex-model",
      });
      expect(getCodexRuntimePreferences(stellaHome, "stella/light").model).toBe(
        "custom-codex-model",
      );
    } finally {
      fs.rmSync(stellaHome, { recursive: true, force: true });
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("decodes file URL image attachment paths before passing them to Codex", () => {
    const filePath = path.join("/tmp", "stella image with spaces.png");

    expect(codexImagePathFromFileUrl(pathToFileURL(filePath).href)).toBe(filePath);
  });

  it("builds localImage inputs for file URL attachments with escaped paths", () => {
    const filePath = path.join("/tmp", "stella image with spaces.png");

    expect(
      buildCodexUserInput({
        runId: "run-attachments",
        prompt: "inspect this",
        attachments: [
          {
            url: pathToFileURL(filePath).href,
            mimeType: "image/png",
          },
        ],
      }).input,
    ).toEqual([
      { type: "text", text: "inspect this", text_elements: [] },
      { type: "localImage", path: filePath },
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
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/new.ts", kind: { type: "add" } },
          {
            path: "/repo/src/existing.ts",
            kind: { type: "update", move_path: null },
          },
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
