import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  buildCodexUserInput,
  buildCodexPromptFromMessages,
  clampCodexSpawnReasoningEffort,
  codexImagePathFromFileUrl,
  CODEX_LIGHT_MODEL,
  CODEX_UTILITY_MODEL,
  extractCodexDeveloperInstructions,
  fileChangesFromCodexItem,
  getCodexRuntimePreferences,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
} from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import {
  buildClaudePromptFromMessages,
  buildExternalStellaHistoryPromptMessage,
  createExternalAssistantUpdateBuffer,
  selectExternalOrchestratorEngine,
} from "../../../../../runtime/kernel/agent-runtime/external-engines.js";
import {
  DEFAULT_CODEX_MODEL,
  updateLocalModelPreferences,
} from "../../../../../runtime/kernel/preferences/local-preferences.js";
import {
  reserveDurableImageOperation,
  settleImageOperation,
} from "../../../../../runtime/kernel/tools/image-operation-store.js";

describe("Codex agent runtime", () => {
  afterEach(() => {
    shutdownCodexAppServerRuntime();
  });

  it("clamps spawn effort against the Codex model/list surface", () => {
    const model = {
      supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({
        reasoningEffort,
        description: "",
      })),
    } as Parameters<typeof clampCodexSpawnReasoningEffort>[0];
    expect(clampCodexSpawnReasoningEffort(model, "low")).toBe("medium");
    expect(clampCodexSpawnReasoningEffort(model, "xhigh")).toBe("high");
  });

  it("drops spawn effort when Codex reports no effort dial", () => {
    expect(
      clampCodexSpawnReasoningEffort({ supportedReasoningEfforts: [] }, "high"),
    ).toBeUndefined();
  });

  it("routes only the General spawned agent to Codex when the shared engine is selected", () => {
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
    ).toBe(false);
    expect(
      shouldUseCodexAgentRuntime({
        agentType: "general",
        agentEngine: "claude_code_local",
      }),
    ).toBe(false);
  });

  it("keeps orchestrator turns on Stella when Codex is the shared engine", () => {
    const opts = {
      agentType: "orchestrator",
      agentContext: {
        agentEngine: "codex_cli",
        model: "stella/standard",
      },
      resolvedLlm: {
        model: { id: "stella/standard" },
      },
    } as unknown as Parameters<typeof selectExternalOrchestratorEngine>[0];

    expect(selectExternalOrchestratorEngine(opts)).toBe(null);
  });

  it("builds a Codex prompt from ordered prompt messages only", () => {
    const prompt = buildCodexPromptFromMessages({
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

    expect(prompt).not.toContain("Stella is delegating");
    expect(prompt).not.toContain("<stella_system_prompt>");
    expect(prompt).not.toContain("You are Stella.");
    expect(prompt).not.toContain("<message");
    expect(prompt).not.toContain("</message>");
    expect(prompt).toContain(
      "[Hidden Stella context 1 (runtime.test)]\nhidden context",
    );
    expect(prompt.trim().endsWith("Do the work.")).toBe(true);
  });

  it("can build Stella thread history for external engine resume fallback prompts", () => {
    const historyPrompt = buildExternalStellaHistoryPromptMessage({
      opts: {
        agentContext: {
          threadHistory: [
            { role: "user", content: "old user question", timestamp: 1 },
            {
              role: "assistant",
              content: "old assistant answer",
              timestamp: 2,
            },
            { role: "user", content: "current question", timestamp: 3 },
          ],
        },
      } as unknown as Parameters<
        typeof buildExternalStellaHistoryPromptMessage
      >[0]["opts"],
      promptMessages: [{ text: "current question" }],
    });

    expect(historyPrompt?.customType).toBe("runtime.stella_thread_history");
    const prompt = buildClaudePromptFromMessages([
      historyPrompt!,
      {
        text: "current question",
        messageType: "user",
        uiVisibility: "visible",
      },
    ]);

    expect(prompt).toContain('<stella_thread_history source="stella"');
    expect(prompt).toContain("old user question");
    expect(prompt).toContain("old assistant answer");
    expect(prompt).not.toContain(
      '<history_message index="3" role="user">\ncurrent question',
    );
    expect(prompt).toContain(
      '<message index="2" type="user" visibility="visible">\ncurrent question\n</message>',
    );
  });

  it("extracts only minimal Stella context for Codex developer instructions", () => {
    expect(
      extractCodexDeveloperInstructions(
        [
          "You are Stella.",
          "",
          "- `~/.stella/outputs/` — generated files go here.",
          "- `~/.stella/projects/<name>/` — scaffolded external projects go here.",
          "",
          "Current working directory: /repo/desktop",
          "",
          "<skills>",
          "- `create-stella-app` — App scaffold.",
          "</skills>",
          "",
          "File edits: use apply_patch.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- `~/.stella/outputs/` — generated files go here.",
        "- `~/.stella/projects/<name>/` — scaffolded external projects go here.",
        "Current working directory: /repo/desktop",
        "",
        "<skills>",
        "- `create-stella-app` — App scaffold.",
        "</skills>",
      ].join("\n"),
    );
  });

  it("preserves source order for extracted Codex developer instructions", () => {
    expect(
      extractCodexDeveloperInstructions(
        [
          "You are Stella.",
          "",
          "- `~/.stella/outputs/` — generated files go here.",
          "- `~/.stella/projects/<name>/` — scaffolded external projects go here.",
          "",
          "Current working directory: /repo/desktop",
          "",
          "<skills>",
          "- `create-stella-app` — App scaffold.",
          "</skills>",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- `~/.stella/outputs/` — generated files go here.",
        "- `~/.stella/projects/<name>/` — scaffolded external projects go here.",
        "Current working directory: /repo/desktop",
        "",
        "<skills>",
        "- `create-stella-app` — App scaffold.",
        "</skills>",
      ].join("\n"),
    );
  });

  it("starts Codex app-server threads without overriding native Codex base instructions", () => {
    expect(
      buildCodexThreadStartParams({
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        systemPrompt:
          "You are Stella.\n\n- `~/.stella/outputs/` — generated files go here.\n\nCurrent working directory: /repo\n\n<skills>\n- `stella-browser` — Browser automation.\n</skills>",
      }),
    ).toEqual({
      model: DEFAULT_CODEX_MODEL,
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "Stella",
      developerInstructions:
        "- `~/.stella/outputs/` — generated files go here.\nCurrent working directory: /repo\n\n<skills>\n- `stella-browser` — Browser automation.\n</skills>",
      ephemeral: false,
      experimentalRawEvents: false,
    });
  });

  it("resumes Codex app-server threads with only Stella skills outside the turn text", () => {
    expect(
      buildCodexThreadResumeParams({
        threadId: "thread-1",
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        systemPrompt:
          "You are Stella.\n\n- `~/.stella/projects/<name>/` — scaffolded external projects go here.\n\nCurrent working directory: /repo\n\n<skills>\n- `create-stella-app` — App scaffold.\n</skills>",
      }),
    ).toEqual({
      threadId: "thread-1",
      model: DEFAULT_CODEX_MODEL,
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions:
        "- `~/.stella/projects/<name>/` — scaffolded external projects go here.\nCurrent working directory: /repo\n\n<skills>\n- `create-stella-app` — App scaffold.\n</skills>",
      excludeTurns: true,
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
      sandboxPolicy: { type: "dangerFullAccess" },
      model: DEFAULT_CODEX_MODEL,
      effort: "high",
    });
  });

  it("uses the Codex mini model for agents that default to Stella Light", () => {
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    try {
      expect(getCodexRuntimePreferences(undefined, "stella/light").model).toBe(
        "gpt-5.4-mini",
      );
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

  it("keeps automatic utility work on Luna, separate from Light agent spawns", () => {
    expect(CODEX_UTILITY_MODEL).toBe("gpt-5.6-luna");
    expect(CODEX_LIGHT_MODEL).toBe("gpt-5.4-mini");
  });

  it("honors a per-spawn pinned Codex model over env and preferences", () => {
    const previousModel = process.env.STELLA_CODEX_MODEL;
    process.env.STELLA_CODEX_MODEL = "env-codex-model";
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-spawn-model-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        codexModel: "custom-codex-model",
      });
      expect(
        getCodexRuntimePreferences(stellaDataDir, undefined, "gpt-5.4-codex")
          .model,
      ).toBe("gpt-5.4-codex");
      // The pin is per-run only — without it the existing order holds.
      expect(getCodexRuntimePreferences(stellaDataDir, undefined).model).toBe(
        "env-codex-model",
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("honors an explicitly-picked Codex model for Stella Light agents", () => {
    // Provenance marker set => the user actively picked this model, so a
    // Stella Light spawn honors it instead of downgrading, and full spawns
    // honor it too.
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-light-model-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        codexModel: "custom-codex-model",
        codexModelExplicit: true,
      });
      expect(
        getCodexRuntimePreferences(stellaDataDir, "stella/light").model,
      ).toBe("custom-codex-model");
      expect(getCodexRuntimePreferences(stellaDataDir, "general").model).toBe(
        "custom-codex-model",
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("honors an explicit gpt-5.5 pick for Stella Light (marker set)", () => {
    // Same string as the legacy baked default, but with the explicit marker
    // it is an intentional pick and must NOT downgrade light spawns.
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-explicit-55-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        codexModel: "gpt-5.5",
        codexModelExplicit: true,
      });
      expect(
        getCodexRuntimePreferences(stellaDataDir, "stella/light").model,
      ).toBe("gpt-5.5");
      expect(getCodexRuntimePreferences(stellaDataDir, "general").model).toBe(
        "gpt-5.5",
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("treats a legacy default codexModel as non-explicit for Stella Light", () => {
    // Pre-upgrade prefs.json bakes the OLD materialized default (gpt-5.5) into
    // codexModel with NO marker. It must not read as an explicit pick, so
    // Stella Light still downgrades while full spawns keep the legacy model.
    const previousModel = process.env.STELLA_CODEX_MODEL;
    delete process.env.STELLA_CODEX_MODEL;
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-legacy-default-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        codexModel: "gpt-5.5",
      });
      expect(
        getCodexRuntimePreferences(stellaDataDir, "stella/light").model,
      ).toBe(CODEX_LIGHT_MODEL);
      expect(getCodexRuntimePreferences(stellaDataDir, "general").model).toBe(
        "gpt-5.5",
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
      if (previousModel === undefined) {
        delete process.env.STELLA_CODEX_MODEL;
      } else {
        process.env.STELLA_CODEX_MODEL = previousModel;
      }
    }
  });

  it("decodes file URL image attachment paths before passing them to Codex", () => {
    const filePath = path.join("/tmp", "stella image with spaces.png");

    expect(codexImagePathFromFileUrl(pathToFileURL(filePath).href)).toBe(
      filePath,
    );
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

  it("fails when Codex app-server starts but never responds", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-silent-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousTimeout = process.env.STELLA_CODEX_REQUEST_TIMEOUT_MS;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_CODEX_REQUEST_TIMEOUT_MS = "25";
    try {
      await expect(
        runCodexAgentTurn({
          runId: "run-silent-codex",
          sessionKey: "session-silent-codex",
          prompt: "hello",
        }),
      ).rejects.toThrow("Codex app-server request initialize timed out");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousTimeout === undefined) {
        delete process.env.STELLA_CODEX_REQUEST_TIMEOUT_MS;
      } else {
        process.env.STELLA_CODEX_REQUEST_TIMEOUT_MS = previousTimeout;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a spawn effort quickly when model/list does not respond", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-slow-model-list-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const capturePath = path.join(dir, "turn-start.json");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'model/list') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-slow-model-list' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    fs.writeFileSync(process.env.STELLA_TEST_CODEX_CAPTURE_PATH, JSON.stringify(message.params));",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-slow-model-list', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    const completedTurn = { id: turn.id, status: 'completed' };",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-slow-model-list', text: 'done' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousEffortTimeout =
      process.env.STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS;
    const previousCapturePath = process.env.STELLA_TEST_CODEX_CAPTURE_PATH;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS = "25";
    process.env.STELLA_TEST_CODEX_CAPTURE_PATH = capturePath;
    try {
      const startedAt = Date.now();
      const result = await runCodexAgentTurn({
        runId: "run-slow-model-list",
        prompt: "hello",
        reasoningEffort: "xhigh",
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(result.text).toBe("done");
      expect(
        JSON.parse(fs.readFileSync(capturePath, "utf8")),
      ).not.toHaveProperty("effort");
    } finally {
      if (previousPath === undefined) delete process.env.STELLA_CODEX_CLI_PATH;
      else process.env.STELLA_CODEX_CLI_PATH = previousPath;
      if (previousEffortTimeout === undefined) {
        delete process.env.STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS;
      } else {
        process.env.STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS =
          previousEffortTimeout;
      }
      if (previousCapturePath === undefined) {
        delete process.env.STELLA_TEST_CODEX_CAPTURE_PATH;
      } else {
        process.env.STELLA_TEST_CODEX_CAPTURE_PATH = previousCapturePath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles when Codex completes the final assistant item before turn completion", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-final-item-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-final' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-final', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-final', command: 'zsh -lc echo noisy', status: 'inProgress' } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'dynamicToolCall', id: 'tool-final', namespace: null, tool: 'spawn_agent', status: 'completed', success: true } } });",
        "    setTimeout(() => {",
        "      const completedTurn = { id: turn.id, status: 'completed' };",
        "      send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: 'done' } } });",
        "      send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "    }, 5);",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const statuses: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-final-item",
        prompt: "hello",
        onStatus: (status) => statuses.push(status),
      });

      expect(result.text).toBe("done");
      expect(statuses).not.toContain("Starting Codex app-server");
      expect(statuses).not.toContain("Codex app-server ready");
      expect(statuses).not.toContain("Codex is working");
      expect(statuses).not.toContain(
        "Codex command inProgress: zsh -lc echo noisy",
      );
      expect(statuses).not.toContain("spawn_agent completed");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes reasoning and redacted built-in command transitions through dedicated callbacks", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-task-progress-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-progress' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-progress', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/reasoning/textDelta', params: { threadId, turnId: turn.id, itemId: 'reasoning-1', delta: 'Authorization: Bearer reasoning-secret' } });",
        "    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId: turn.id, itemId: 'reasoning-1', delta: ' Cookie: session=reasoning-cookie' } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'webSearch', id: 'search-progress', query: 'Authorization: Bearer search-secret' } } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-progress', command: 'API_TOKEN=super-secret curl Authorization: Bearer header-secret --token also-secret', cwd: '/repo/API_KEY=cwd-secret', status: 'inProgress' } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-progress', command: 'API_TOKEN=super-secret curl Authorization: Bearer header-secret --token also-secret', cwd: '/repo/API_KEY=cwd-secret', status: 'completed', exitCode: 0 } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-progress', text: 'done', phase: 'final_answer' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: { id: turn.id, status: 'completed' } } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const reasoning: string[] = [];
    const statuses: string[] = [];
    const commands: Array<{
      command: string;
      status: string;
      exitCode?: number | null;
    }> = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-task-progress",
        prompt: "check the build",
        onReasoning: (chunk) => reasoning.push(chunk),
        onStatus: (status) => statuses.push(status),
        onCommandExecution: (activity) => commands.push(activity),
      });

      expect(result.text).toBe("done");
      expect(reasoning.join("")).toContain("[REDACTED]");
      expect(commands.map((command) => command.status)).toEqual([
        "inProgress",
        "completed",
      ]);
      expect(commands[0]?.command).toContain("API_TOKEN=[REDACTED]");
      // Guard against a silently vacuous redaction test: the fixture script
      // must genuinely emit every secret so the not.toContain checks below are
      // meaningful (secret present in raw input, absent after redaction).
      const fixtureScript = fs.readFileSync(fakeCodex, "utf8");
      for (const secret of [
        "reasoning-secret",
        "reasoning-cookie",
        "search-secret",
        "super-secret",
        "header-secret",
        "also-secret",
        "cwd-secret",
      ]) {
        expect(fixtureScript).toContain(secret);
      }
      const serializedProgress = JSON.stringify({
        reasoning,
        statuses,
        commands,
      });
      for (const secret of [
        "reasoning-secret",
        "reasoning-cookie",
        "search-secret",
        "super-secret",
        "header-secret",
        "also-secret",
        "cwd-secret",
      ]) {
        expect(serializedProgress).not.toContain(secret);
      }
      expect(commands[1]?.exitCode).toBe(0);
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps benign key=value reasoning readable while redacting secrets", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-benign-reasoning-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-benign' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-benign', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/reasoning/textDelta', params: { threadId, turnId: turn.id, itemId: 'reasoning-benign', delta: 'retrying with retries=3 count=0 timeout=30 then FOO_TOKEN=leak-me' } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-benign', text: 'done', phase: 'final_answer' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: { id: turn.id, status: 'completed' } } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const reasoning: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-benign-reasoning",
        prompt: "retry",
        onReasoning: (chunk) => reasoning.push(chunk),
      });

      expect(result.text).toBe("done");
      const joined = reasoning.join("");
      // Plain short numeric/identifier assignments must survive redaction so
      // the reasoning the feature exists to surface stays readable.
      expect(joined).toContain("retries=3");
      expect(joined).toContain("count=0");
      expect(joined).toContain("timeout=30");
      // A genuinely sensitive assignment in the same delta is still redacted.
      expect(joined).not.toContain("leak-me");
      expect(joined).toContain("[REDACTED]");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a final Codex assistant item sent after turn completion", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-late-final-item-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-late-final' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-late-final', status: 'inProgress' };",
        "    const completedTurn = { id: turn.id, status: 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "    setTimeout(() => send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-late-final', text: 'late done' } } }), 25);",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-late-final-item",
        prompt: "hello",
      });

      expect(result.text).toBe("late done");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can suppress final-answer streaming while still returning the Codex result", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-suppressed-stream-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-suppressed-stream' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-suppressed-stream', status: 'inProgress' };",
        "    const completedTurn = { id: turn.id, status: 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'msg-suppressed-stream', delta: 'task ' } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'msg-suppressed-stream', delta: 'done' } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-suppressed-stream', text: 'task done', phase: 'final_answer' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const streamed: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-suppressed-stream",
        prompt: "hello",
        streamFinalAnswer: false,
        onStream: (chunk) => streamed.push(chunk),
      });

      expect(result.text).toBe("task done");
      expect(streamed).toEqual([]);
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers commentary through suppressed final streaming and flushes each native boundary once", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-authored-boundaries-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-authored-boundaries' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-authored-boundaries', status: 'inProgress' };",
        "    const completedTurn = { id: turn.id, status: 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'comment-command', text: '', phase: 'commentary' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'comment-command', delta: 'I will inspect the process.' } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', status: 'inProgress' } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', status: 'completed', exitCode: 0 } } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'comment-search', text: '', phase: 'commentary' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'comment-search', delta: 'I will verify the docs.' } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'webSearch', id: 'search-1', query: 'Codex docs' } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'webSearch', id: 'search-1', query: 'Codex docs' } } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'comment-file', text: '', phase: 'commentary' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'comment-file', delta: 'I will apply the fix.' } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'fileChange', id: 'file-1', changes: [{ path: 'runtime/fix.ts', kind: { type: 'update', move_path: null } }], status: 'inProgress' } } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'fileChange', id: 'file-1', changes: [{ path: 'runtime/fix.ts', kind: { type: 'update', move_path: null } }], status: 'completed' } } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'final-1', text: '', phase: 'final_answer' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'final-1', delta: 'Final result only.' } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'final-1', text: 'Final result only.', phase: 'final_answer' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const appendThreadMessage = vi.fn();
    const updateBuffer = createExternalAssistantUpdateBuffer({
      store: { appendThreadMessage } as never,
      threadKey: "agent-codex",
      engine: "codex",
      runId: "run-authored-boundaries",
      attemptGeneration: 4,
    });
    const commentary: string[] = [];
    const finalStream: string[] = [];
    const nativeStarts = vi.fn(
      (activity: {
        toolCallId: string;
        toolName: string;
        toolArgs: Record<string, unknown>;
      }) => {
        updateBuffer.flushBeforeTool();
        return activity;
      },
    );
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-authored-boundaries",
        prompt: "Inspect, verify, and fix.",
        cwd: dir,
        streamFinalAnswer: false,
        onCommentaryStream: (chunk) => {
          commentary.push(chunk);
          updateBuffer.append(chunk);
        },
        onNativeToolStart: nativeStarts,
        onStream: (chunk) => finalStream.push(chunk),
      });
      updateBuffer.discard();

      expect(result.text).toBe("Final result only.");
      expect(commentary).toEqual([
        "I will inspect the process.",
        "I will verify the docs.",
        "I will apply the fix.",
      ]);
      expect(finalStream).toEqual([]);
      expect(nativeStarts).toHaveBeenCalledTimes(3);
      expect(nativeStarts.mock.calls.map(([activity]) => activity)).toEqual([
        {
          toolCallId: "cmd-1",
          toolName: "exec_command",
          toolArgs: { command: "pwd" },
        },
        {
          toolCallId: "search-1",
          toolName: "web_search",
          toolArgs: { query: "Codex docs" },
        },
        {
          toolCallId: "file-1",
          toolName: "file_change",
          toolArgs: { paths: ["runtime/fix.ts"] },
        },
      ]);
      expect(appendThreadMessage).toHaveBeenCalledTimes(3);
      expect(
        appendThreadMessage.mock.calls.map(
          ([entry]) => (entry as { content: string }).content,
        ),
      ).toEqual(commentary);
      expect(JSON.stringify(appendThreadMessage.mock.calls)).not.toContain(
        "Final result only.",
      );
      expect(result.fileChanges).toEqual([
        {
          path: path.join(dir, "runtime/fix.ts"),
          kind: { type: "update" },
        },
      ]);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not finish on a commentary assistant message before Codex keeps working", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-commentary-before-tool-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-commentary' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-commentary', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-commentary', text: 'I will check that now.', phase: 'commentary' } } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-commentary', command: 'sleep 1', status: 'inProgress' } } });",
        "    setTimeout(() => {",
        "      const completedTurn = { id: turn.id, status: 'completed' };",
        "      send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-commentary', command: 'sleep 1', status: 'completed' } } });",
        "      send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: 'actual final answer', phase: 'final_answer' } } });",
        "      send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "    }, 900);",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-commentary-before-tool",
        prompt: "hello",
      });

      expect(result.text).toBe("actual final answer");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not time out while a native Codex command is still in progress", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-long-command-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-long-command' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-long-command', status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-long', command: 'sleep 60', status: 'inProgress' } } });",
        "    setTimeout(() => {",
        "      const completedTurn = { id: turn.id, status: 'completed' };",
        "      send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'commandExecution', id: 'cmd-long', command: 'sleep 60', status: 'completed', exitCode: 0 } } });",
        "      send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: 'command finished', phase: 'final_answer' } } });",
        "      send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "    }, 60);",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousTimeout = process.env.STELLA_CODEX_TURN_IDLE_TIMEOUT_MS;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_CODEX_TURN_IDLE_TIMEOUT_MS = "25";
    try {
      const result = await runCodexAgentTurn({
        runId: "run-long-command",
        prompt: "run it",
      });
      expect(result.text).toBe("command finished");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousTimeout === undefined) {
        delete process.env.STELLA_CODEX_TURN_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_CODEX_TURN_IDLE_TIMEOUT_MS = previousTimeout;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak commentary preamble deltas into the final Codex answer", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-commentary-delta-"),
    );
    const fakeCodex = path.join(dir, "codex");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const readline = require("node:readline");',
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-commentary-delta' } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: 'turn-commentary-delta', status: 'inProgress' };",
        "    const completedTurn = { id: turn.id, status: 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        // Commentary preamble streamed as deltas (external-engines flushes it as
        // its own bubble). These must NOT accumulate into finalText.
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-pre', text: '', phase: 'commentary' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'msg-pre', delta: 'Let me look that up. ' } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-pre', text: 'Let me look that up.', phase: 'commentary' } } });",
        // The authoritative final answer.
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: '', phase: 'final_answer' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'msg-final', delta: 'The answer is 42.' } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: 'The answer is 42.', phase: 'final_answer' } } });",
        // Trailing commentary streamed after the final item lands (arrives during
        // the completion grace window) must also stay out of finalText.
        "    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-note', text: '', phase: 'commentary' } } });",
        "    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'msg-note', delta: ' Let me know if you need more.' } });",
        "    send({ method: 'turn/completed', params: { threadId, turn: completedTurn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const streamed: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    try {
      const result = await runCodexAgentTurn({
        runId: "run-commentary-delta",
        prompt: "hello",
        onCommentaryStream: (chunk) => streamed.push(chunk),
        onStream: (chunk) => streamed.push(chunk),
      });

      // Persisted answer is the final answer only — never the commentary
      // preamble or the trailing commentary.
      expect(result.text).toBe("The answer is 42.");
      // Streaming still surfaces every delta live (that is how the preamble
      // bubble gets painted); only finalText excludes commentary.
      expect(streamed).toContain("Let me look that up. ");
      expect(streamed).toContain("The answer is 42.");
    } finally {
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the Codex app-server process for shared turns", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-shared-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const startsFile = path.join(dir, "starts.txt");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "fs.appendFileSync(process.env.STELLA_FAKE_CODEX_STARTS_FILE, 'start\\n');",
        "let turnCount = 0;",
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { send({ id: message.id, result: { thread: { id: 'thread-shared' } } }); return; }",
        "  if (message.method === 'thread/resume') { send({ id: message.id, result: { thread: { id: message.params.threadId } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    turnCount += 1;",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: `turn-${turnCount}`, status: 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: `msg-${turnCount}`, text: `done ${turnCount}` } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousStartsFile = process.env.STELLA_FAKE_CODEX_STARTS_FILE;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_FAKE_CODEX_STARTS_FILE = startsFile;
    try {
      const first = await runCodexAgentTurn({
        runId: "run-shared-1",
        prompt: "hello",
        reuseAppServer: true,
      });
      const second = await runCodexAgentTurn({
        runId: "run-shared-2",
        prompt: "again",
        persistedSessionId: first.sessionId,
        reuseAppServer: true,
      });

      expect(first.sessionId).toBe("thread-shared");
      expect(second.text).toBe("done 2");
      expect(fs.readFileSync(startsFile, "utf8").trim().split("\n")).toEqual([
        "start",
      ]);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousStartsFile === undefined) {
        delete process.env.STELLA_FAKE_CODEX_STARTS_FILE;
      } else {
        process.env.STELLA_FAKE_CODEX_STARTS_FILE = previousStartsFile;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes concurrent shared Codex tool requests to the matching turn", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-concurrent-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const startsFile = path.join(dir, "starts.txt");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "fs.appendFileSync(process.env.STELLA_FAKE_CODEX_STARTS_FILE, 'start\\n');",
        "let threadCount = 0;",
        "let turnCount = 0;",
        "let requestId = 100;",
        "const pending = new Map();",
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { threadCount += 1; send({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    turnCount += 1;",
        "    const label = turnCount === 1 ? 'alpha' : 'beta';",
        "    const threadId = message.params.threadId;",
        "    const turn = { id: `turn-${turnCount}`, status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    const id = requestId++;",
        "    pending.set(id, { threadId, turnId: turn.id, label });",
        "    send({ id, method: 'item/tool/call', params: { threadId, turnId: turn.id, callId: `call-${label}`, namespace: null, tool: 'test_tool', arguments: { label } } });",
        "    return;",
        "  }",
        "  if (message.id !== undefined && pending.has(message.id)) {",
        "    const pendingTurn = pending.get(message.id);",
        "    pending.delete(message.id);",
        "    const turn = { id: pendingTurn.turnId, status: 'completed' };",
        "    send({ method: 'item/completed', params: { threadId: pendingTurn.threadId, turnId: pendingTurn.turnId, item: { type: 'agentMessage', id: `msg-${pendingTurn.label}`, text: `done ${pendingTurn.label}` } } });",
        "    send({ method: 'turn/completed', params: { threadId: pendingTurn.threadId, turn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousStartsFile = process.env.STELLA_FAKE_CODEX_STARTS_FILE;
    const toolCalls: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_FAKE_CODEX_STARTS_FILE = startsFile;
    try {
      const executeTool = async (
        _toolCallId: string,
        toolName: string,
        toolArgs: Record<string, unknown>,
      ) => {
        toolCalls.push(`${toolName}:${String(toolArgs.label)}`);
        return { result: `ok ${String(toolArgs.label)}` };
      };
      const [first, second] = await Promise.all([
        runCodexAgentTurn({
          runId: "run-concurrent-a",
          prompt: "first",
          reuseAppServer: true,
          executeTool,
        }),
        runCodexAgentTurn({
          runId: "run-concurrent-b",
          prompt: "second",
          reuseAppServer: true,
          executeTool,
        }),
      ]);

      expect([first.text, second.text].sort()).toEqual([
        "done alpha",
        "done beta",
      ]);
      expect(toolCalls.sort()).toEqual(["test_tool:alpha", "test_tool:beta"]);
      expect(fs.readFileSync(startsFile, "utf8").trim().split("\n")).toEqual([
        "start",
      ]);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousStartsFile === undefined) {
        delete process.env.STELLA_FAKE_CODEX_STARTS_FILE;
      } else {
        process.env.STELLA_FAKE_CODEX_STARTS_FILE = previousStartsFile;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reattaches a terminal image result through an actual Codex app-server process restart", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-image-restart-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const startsFile = path.join(dir, "starts.txt");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "fs.appendFileSync(process.env.STELLA_FAKE_CODEX_STARTS_FILE, 'start\\n');",
        "const processNumber = fs.readFileSync(process.env.STELLA_FAKE_CODEX_STARTS_FILE, 'utf8').trim().split('\\n').length;",
        "let threadId = '';",
        "let turnId = '';",
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { threadId = `thread-${processNumber}`; send({ id: message.id, result: { thread: { id: threadId } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    turnId = `turn-${processNumber}`;",
        "    const turn = { id: turnId, status: 'inProgress' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId, turn } });",
        "    send({ id: 900, method: 'item/tool/call', params: { threadId, turnId, callId: 'codex-image-stable-call', namespace: null, tool: 'image_gen', arguments: { prompt: 'durable codex fox' } } });",
        "    return;",
        "  }",
        "  if (message.id === 900) {",
        "    if (processNumber === 1) { process.exit(17); return; }",
        "    const turn = { id: turnId, status: 'completed' };",
        "    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'final-image', text: 'terminal image delivered after restart' } } });",
        "    send({ method: 'turn/completed', params: { threadId, turn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousStartsFile = process.env.STELLA_FAKE_CODEX_STARTS_FILE;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_FAKE_CODEX_STARTS_FILE = startsFile;
    let submissions = 0;
    let adapterCalls = 0;
    const executeTool = async (
      toolCallId: string,
      _toolName: string,
      toolArgs: Record<string, unknown>,
    ) => {
      adapterCalls += 1;
      const operation = reserveDurableImageOperation({
        stellaDataDir: dir,
        conversationId: "codex-app-server-restart",
        toolCallId,
        requestBody: toolArgs,
      });
      if (!operation.terminalResult) {
        submissions += 1;
        settleImageOperation({
          stellaDataDir: dir,
          operationId: operation.operationId,
          result: {
            ok: true,
            job: {
              jobId: "codex-image-job",
              capability: "text_to_image",
              profile: "best",
              status: "succeeded",
            },
            filePaths: [],
            artifacts: [],
            reattached: false,
          },
        });
      }
      return {
        result: operation.terminalResult ?? {
          jobId: "codex-image-job",
          status: "succeeded",
        },
      };
    };
    try {
      await expect(
        runCodexAgentTurn({
          runId: "codex-image-before-crash",
          prompt: "generate image",
          reuseAppServer: true,
          executeTool,
        }),
      ).rejects.toThrow();
      const restarted = await runCodexAgentTurn({
        runId: "codex-image-after-restart",
        prompt: "continue image generation",
        reuseAppServer: true,
        executeTool,
      });
      expect(restarted.text).toBe("terminal image delivered after restart");
      expect(submissions).toBe(1);
      expect(adapterCalls).toBe(2);
      expect(
        fs.readFileSync(startsFile, "utf8").trim().split("\n"),
      ).toHaveLength(2);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) delete process.env.STELLA_CODEX_CLI_PATH;
      else process.env.STELLA_CODEX_CLI_PATH = previousPath;
      if (previousStartsFile === undefined)
        delete process.env.STELLA_FAKE_CODEX_STARTS_FILE;
      else process.env.STELLA_FAKE_CODEX_STARTS_FILE = previousStartsFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not route a shared Codex tool request to a turn still awaiting thread start", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-delayed-thread-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const startsFile = path.join(dir, "starts.txt");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "fs.appendFileSync(process.env.STELLA_FAKE_CODEX_STARTS_FILE, 'start\\n');",
        "let threadCount = 0;",
        "let requestId = 100;",
        "const pending = new Map();",
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "const startTurn = (message) => {",
        "  const threadId = message.params.threadId;",
        "  const label = threadId === 'thread-alpha' ? 'alpha' : 'beta';",
        "  const turn = { id: `turn-${label}`, status: 'inProgress' };",
        "  send({ id: message.id, result: { turn } });",
        "  send({ method: 'turn/started', params: { threadId, turn } });",
        "  const id = requestId++;",
        "  pending.set(id, { threadId, turnId: turn.id, label });",
        "  send({ id, method: 'item/tool/call', params: { threadId, turnId: turn.id, callId: `call-${label}`, namespace: null, tool: 'test_tool', arguments: { label } } });",
        "};",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') {",
        "    threadCount += 1;",
        "    if (threadCount === 1) {",
        "      setTimeout(() => send({ id: message.id, result: { thread: { id: 'thread-alpha' } } }), 80);",
        "      return;",
        "    }",
        "    send({ id: message.id, result: { thread: { id: 'thread-beta' } } });",
        "    return;",
        "  }",
        "  if (message.method === 'turn/start') { startTurn(message); return; }",
        "  if (message.id !== undefined && pending.has(message.id)) {",
        "    const pendingTurn = pending.get(message.id);",
        "    pending.delete(message.id);",
        "    const turn = { id: pendingTurn.turnId, status: 'completed' };",
        "    send({ method: 'item/completed', params: { threadId: pendingTurn.threadId, turnId: pendingTurn.turnId, item: { type: 'agentMessage', id: `msg-${pendingTurn.label}`, text: `done ${pendingTurn.label}` } } });",
        "    send({ method: 'turn/completed', params: { threadId: pendingTurn.threadId, turn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousStartsFile = process.env.STELLA_FAKE_CODEX_STARTS_FILE;
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_FAKE_CODEX_STARTS_FILE = startsFile;
    try {
      const [first, second] = await Promise.all([
        runCodexAgentTurn({
          runId: "run-delayed-thread-a",
          prompt: "first",
          reuseAppServer: true,
          executeTool: async (
            _toolCallId,
            toolName,
            toolArgs: Record<string, unknown>,
          ) => {
            firstCalls.push(`${toolName}:${String(toolArgs.label)}`);
            return { result: `first ${String(toolArgs.label)}` };
          },
        }),
        runCodexAgentTurn({
          runId: "run-delayed-thread-b",
          prompt: "second",
          reuseAppServer: true,
          executeTool: async (
            _toolCallId,
            toolName,
            toolArgs: Record<string, unknown>,
          ) => {
            secondCalls.push(`${toolName}:${String(toolArgs.label)}`);
            return { result: `second ${String(toolArgs.label)}` };
          },
        }),
      ]);

      expect(first.text).toBe("done alpha");
      expect(second.text).toBe("done beta");
      expect(firstCalls).toEqual(["test_tool:alpha"]);
      expect(secondCalls).toEqual(["test_tool:beta"]);
      expect(fs.readFileSync(startsFile, "utf8").trim().split("\n")).toEqual([
        "start",
      ]);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousStartsFile === undefined) {
        delete process.env.STELLA_FAKE_CODEX_STARTS_FILE;
      } else {
        process.env.STELLA_FAKE_CODEX_STARTS_FILE = previousStartsFile;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes the Codex thread id before an interrupted turn completes", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-codex-interrupt-resume-"),
    );
    const fakeCodex = path.join(dir, "codex");
    const methodsFile = path.join(dir, "methods.txt");
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const readline = require("node:readline");',
        "let turnCount = 0;",
        "const threadId = 'thread-resume-target';",
        "const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');",
        "const log = (line) => fs.appendFileSync(process.env.STELLA_FAKE_CODEX_METHODS_FILE, line + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') { send({ id: message.id, result: {} }); return; }",
        "  if (message.method === 'initialized') return;",
        "  if (message.method === 'thread/start') { log('thread/start'); send({ id: message.id, result: { thread: { id: threadId } } }); return; }",
        "  if (message.method === 'thread/resume') { log(`thread/resume:${message.params.threadId}`); send({ id: message.id, result: { thread: { id: message.params.threadId } } }); return; }",
        "  if (message.method === 'turn/start') {",
        "    turnCount += 1;",
        "    const turn = { id: `turn-${turnCount}`, status: turnCount === 1 ? 'inProgress' : 'completed' };",
        "    send({ id: message.id, result: { turn } });",
        "    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn } });",
        "    if (turnCount === 1) {",
        "      send({ method: 'item/reasoning/textDelta', params: { threadId: message.params.threadId, turnId: turn.id, delta: 'first turn started' } });",
        "      return;",
        "    }",
        "    send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-2', text: 'resumed same Codex thread' } } });",
        "    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn } });",
        "    return;",
        "  }",
        "  if (message.method === 'turn/interrupt') {",
        "    send({ id: message.id, result: {} });",
        "    const turn = { id: message.params.turnId, status: 'interrupted' };",
        "    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn } });",
        "  }",
        "});",
        "process.stdin.resume();",
      ].join("\n"),
    );
    fs.chmodSync(fakeCodex, 0o755);
    const previousPath = process.env.STELLA_CODEX_CLI_PATH;
    const previousMethodsFile = process.env.STELLA_FAKE_CODEX_METHODS_FILE;
    process.env.STELLA_CODEX_CLI_PATH = fakeCodex;
    process.env.STELLA_FAKE_CODEX_METHODS_FILE = methodsFile;
    const observedSessionIds: string[] = [];
    let markFirstTurnStarted: (() => void) | null = null;
    const firstTurnStarted = new Promise<void>((resolve) => {
      markFirstTurnStarted = resolve;
    });
    const controller = new AbortController();

    try {
      const first = runCodexAgentTurn({
        runId: "run-codex-interrupt-1",
        prompt: "start",
        reuseAppServer: true,
        abortSignal: controller.signal,
        onSessionId: (sessionId) => {
          observedSessionIds.push(sessionId);
        },
        onReasoning: (reasoning) => {
          if (reasoning === "first turn started") markFirstTurnStarted?.();
        },
      });

      await firstTurnStarted;
      controller.abort(new Error("Interrupted by agent input"));
      await expect(first).rejects.toThrow(/interrupted|aborted/i);

      expect(observedSessionIds).toEqual(["thread-resume-target"]);

      const second = await runCodexAgentTurn({
        runId: "run-codex-interrupt-2",
        prompt: "follow-up",
        persistedSessionId: observedSessionIds[0],
        reuseAppServer: true,
      });

      expect(second.text).toBe("resumed same Codex thread");
      expect(fs.readFileSync(methodsFile, "utf8").trim().split("\n")).toEqual([
        "thread/start",
        "thread/resume:thread-resume-target",
      ]);
    } finally {
      shutdownCodexAppServerRuntime();
      if (previousPath === undefined) {
        delete process.env.STELLA_CODEX_CLI_PATH;
      } else {
        process.env.STELLA_CODEX_CLI_PATH = previousPath;
      }
      if (previousMethodsFile === undefined) {
        delete process.env.STELLA_FAKE_CODEX_METHODS_FILE;
      } else {
        process.env.STELLA_FAKE_CODEX_METHODS_FILE = previousMethodsFile;
      }
      fs.rmSync(dir, { recursive: true, force: true });
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
