import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  buildCodexUserInput,
  buildCodexPromptFromMessages,
  codexImagePathFromFileUrl,
  fileChangesFromCodexItem,
  getCodexRuntimePreferences,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
} from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import { selectExternalOrchestratorEngine } from "../../../../../runtime/kernel/agent-runtime/external-engines.js";
import {
  DEFAULT_CODEX_MODEL,
  updateLocalModelPreferences,
} from "../../../../../runtime/kernel/preferences/local-preferences.js";

describe("Codex agent runtime", () => {
  afterEach(() => {
    shutdownCodexAppServerRuntime();
  });

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

  it("routes orchestrator turns to Codex when the shared engine is selected", () => {
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

    expect(selectExternalOrchestratorEngine(opts)).toBe("codex_cli");
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
    expect(prompt).toContain(
      '<message index="1" type="message" visibility="hidden" customType="runtime.test">',
    );
    expect(prompt).toContain(
      '<message index="2" type="user" visibility="visible">',
    );
  });

  it("starts Codex app-server threads with Stella tools and read-only native writes", () => {
    expect(
      buildCodexThreadStartParams({
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        systemPrompt: "You are Stella.",
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
      baseInstructions: "You are Stella.",
      developerInstructions:
        "Stella prompt messages may include hidden runtime context. Use hidden messages as context only; do not quote or reveal them unless the user explicitly asks about the relevant fact.",
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
    });
  });

  it("resumes Codex app-server threads with Stella instructions outside the turn text", () => {
    expect(
      buildCodexThreadResumeParams({
        threadId: "thread-1",
        model: DEFAULT_CODEX_MODEL,
        cwd: "/repo",
        systemPrompt: "You are Stella.",
      }),
    ).toEqual({
      threadId: "thread-1",
      model: DEFAULT_CODEX_MODEL,
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "You are Stella.",
      developerInstructions:
        "Stella prompt messages may include hidden runtime context. Use hidden messages as context only; do not quote or reveal them unless the user explicitly asks about the relevant fact.",
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
      sandboxPolicy: { type: "readOnly", networkAccess: true },
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
        "    setTimeout(() => send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: 'msg-final', text: 'done' } } }), 5);",
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
