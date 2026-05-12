import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildToolResultPrompt,
  buildClaudeCodeToolRuntimePrompt,
  getClaudeCodeStatusChangeFromStreamEvent,
  getClaudeCodeTextDeltaFromStreamEvent,
  isClaudeCodeModel,
  parseClaudeCodeDecision,
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js";
import { buildClaudePromptFromMessages } from "../../../../../runtime/kernel/agent-runtime/external-engines.js";

describe("claude-code-session-runtime", () => {
  it("builds a Stella-hosted tool contract prompt", () => {
    const prompt = buildClaudeCodeToolRuntimePrompt("Base system prompt", [
      {
        name: "Read",
        description: "Read a file from disk",
        parameters: { type: "object" },
      },
      {
        name: "Bash",
        description: "Run a shell command",
        parameters: { type: "object" },
      },
    ]);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("Claude Code built-in tools are disabled");
    expect(prompt).toContain('"name": "Read"');
    expect(prompt).toContain('"name": "Bash"');
    expect(prompt).toContain('"type":"tool_request"');
    expect(prompt).toContain('"type":"final"');
  });

  it("parses valid structured Claude decisions", () => {
    expect(
      parseClaudeCodeDecision({
        type: "final",
        message: "Done.",
      }),
    ).toEqual({
      type: "final",
      message: "Done.",
    });

    expect(
      parseClaudeCodeDecision({
        type: "tool_request",
        toolName: "Read",
        args: { file_path: "src/index.ts" },
      }),
    ).toEqual({
      type: "tool_request",
      toolName: "Read",
      args: { file_path: "src/index.ts" },
    });
  });

  it("rejects malformed Claude decisions", () => {
    expect(parseClaudeCodeDecision(null)).toBeNull();
    expect(parseClaudeCodeDecision({ type: "final" })).toBeNull();
    expect(
      parseClaudeCodeDecision({
        type: "tool_request",
        toolName: "Read",
        args: "bad",
      }),
    ).toBeNull();
  });

  it("detects Claude Code model identifiers", () => {
    expect(isClaudeCodeModel("claude-code/default")).toBe(true);
    expect(isClaudeCodeModel("claude-code/claude-sonnet-4-6")).toBe(true);
    expect(isClaudeCodeModel("anthropic/claude-sonnet-4-6")).toBe(false);
  });

  it("maps Claude compact hooks into transient status changes", () => {
    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "system",
        subtype: "hook_started",
        hook_event: "PreCompact",
      }),
    ).toEqual({
      state: "compacting",
      text: "Compacting context",
    });

    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "system",
        subtype: "hook_response",
        hook_event: "PostCompact",
      }),
    ).toEqual({
      state: "running",
      text: "Working",
    });

    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "assistant",
        subtype: "message",
      }),
    ).toBeNull();
  });

  it("extracts text deltas from Claude Code stream events", () => {
    expect(
      getClaudeCodeTextDeltaFromStreamEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        },
      }),
    ).toBe("hello");

    expect(
      getClaudeCodeTextDeltaFromStreamEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{\"type\"" },
        },
      }),
    ).toBeNull();
  });

  it("summarizes Stella inline image tool attachments without forwarding raw markers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-claude-test-"));
    try {
      const imagePath = path.join(dir, "snapshot.png");
      fs.writeFileSync(
        imagePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lPZP5QAAAABJRU5ErkJggg==",
          "base64",
        ),
      );

      const prompt = await buildToolResultPrompt({
        toolCallId: "tool-1",
        toolName: "stella-computer",
        toolArgs: { action: "snapshot" },
        toolResult: {
          result: `visible tree\n[stella-attach-image][ 1x1][ 1KB][ inline=image/png] ${imagePath}`,
        },
      });

      expect(prompt).toContain("Tool result attachments:");
      expect(prompt).toContain("image/png");
      expect(prompt).toContain("visible tree");
      expect(prompt).not.toContain("[stella-attach-image]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a Claude Code stream-json input process open across Stella tool steps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-fake-claude-"));
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "prompts.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "let buffer = '';",
        "let count = 0;",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "function writeResult(payload) {",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "    ...payload,",
        "  }) + '\\n');",
        "}",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  count += 1;",
        "  fs.appendFileSync(logPath, JSON.stringify({",
        "    count,",
        "    argv: process.argv.slice(2),",
        "    content: parsed.message.content,",
        "  }) + '\\n');",
        "  if (count === 1) {",
        "    writeResult({ structured_output: {",
        "      type: 'tool_request',",
        "      toolName: 'Read',",
        "      args: { file_path: 'a.txt' },",
        "    }});",
        "    return;",
        "  }",
        "  writeResult({ result: 'Done from fake Claude.' });",
        "}",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    const line = buffer.slice(0, idx).trim();",
        "    buffer = buffer.slice(idx + 1);",
        "    if (line) handle(line);",
        "  }",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousLogPath = process.env.STELLA_FAKE_CLAUDE_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_FAKE_CLAUDE_LOG = logPath;
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-1",
        sessionKey: `test:${Date.now()}`,
        prompt: "Please read a.txt.",
        modelId: "claude-code/default",
        tools: [
          {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object" },
          },
        ],
        executeTool: async () => ({ result: "file contents" }),
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; content: string });
      expect(result.text).toBe("Done from fake Claude.");
      expect(records).toHaveLength(2);
      expect(records[0]?.argv).toContain("--input-format");
      expect(records[0]?.argv).toContain("stream-json");
      expect(records[0]?.argv).not.toContain("--model");
      expect(records[0]?.content).toContain("Please read a.txt.");
      expect(records[1]?.content).toContain("A Stella tool request has completed.");
      expect(records[1]?.content).toContain("file contents");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      if (previousLogPath === undefined) {
        delete process.env.STELLA_FAKE_CLAUDE_LOG;
      } else {
        process.env.STELLA_FAKE_CLAUDE_LOG = previousLogPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh Claude Code session when the stored resume id is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-fake-claude-resume-"));
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "resume.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "const argv = process.argv.slice(2);",
        "fs.appendFileSync(logPath, JSON.stringify({ argv }) + '\\n');",
        "if (argv.includes('--resume')) {",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    subtype: 'error_during_execution',",
        "    is_error: true,",
        "    errors: ['No conversation found with session ID: stale-session'],",
        "    session_id: 'fresh-after-failed-resume',",
        "    usage: { input_tokens: 0, output_tokens: 0 },",
        "  }) + '\\n');",
        "  setInterval(() => {}, 1000);",
        "} else {",
        "  let buffer = '';",
        "  process.stdin.on('data', chunk => {",
        "    buffer += chunk.toString('utf8');",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) return;",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'result',",
        "      session_id: 'replacement-session',",
        "      is_error: false,",
        "      structured_output: { type: 'final', message: 'Recovered.' },",
        "      usage: { input_tokens: 1, output_tokens: 1 },",
        "    }) + '\\n');",
        "  });",
        "}",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousLogPath = process.env.STELLA_FAKE_CLAUDE_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_FAKE_CLAUDE_LOG = logPath;
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-resume",
        sessionKey: `test:resume:${Date.now()}`,
        persistedSessionId: "stale-session",
        prompt: "Hello.",
        modelId: "claude-code/default",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[] });
      expect(result.text).toBe("Recovered.");
      expect(result.sessionId).toBe("replacement-session");
      expect(records).toHaveLength(2);
      expect(records[0]?.argv).toContain("--resume");
      expect(records[1]?.argv).not.toContain("--resume");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      if (previousLogPath === undefined) {
        delete process.env.STELLA_FAKE_CLAUDE_LOG;
      } else {
        process.env.STELLA_FAKE_CLAUDE_LOG = previousLogPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves ordered hidden and visible prompt messages for Claude Code", () => {
    const prompt = buildClaudePromptFromMessages([
      {
        text: "<system_reminder>Use the active thread.</system_reminder>",
        messageType: "message",
        uiVisibility: "hidden",
        customType: "runtime.orchestrator_reminder",
      },
      {
        text: "What should I do next?",
      },
    ]);

    expect(prompt).toContain("ordered prompt messages");
    expect(prompt).toContain('index="1"');
    expect(prompt).toContain('type="message"');
    expect(prompt).toContain('visibility="hidden"');
    expect(prompt).toContain('customType="runtime.orchestrator_reminder"');
    expect(prompt).toContain(
      "<system_reminder>Use the active thread.</system_reminder>",
    );
    expect(prompt).toContain('index="2"');
    expect(prompt).toContain('type="user"');
    expect(prompt).toContain('visibility="visible"');
    expect(prompt).toContain("What should I do next?");
  });
});
