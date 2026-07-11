import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildToolResultPrompt,
  buildClaudeCodeToolRuntimePrompt,
  claudeCodeSessionHasActiveProcess,
  collectClaudeCodeNativeFileChanges,
  createClaudeCodeStreamEmitter,
  getClaudeCodeModelFallbackFromStreamEvent,
  isClaudeCodeModelRefusalOrOverloadError,
  getClaudeCodeStatusChangeFromStreamEvent,
  getClaudeCodeTextDeltaFromStreamEvent,
  isClaudeCodeModel,
  listClaudeCodeModels,
  parseClaudeCodeDecision,
  runClaudeCodeTurn,
  scheduleClaudeCodeSessionCloseWhenIdle,
  shutdownClaudeCodeRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js";
import { recordClaudeCodeResolvedModel } from "../../../../../runtime/kernel/integrations/claude-code-resolved-models.js";
import {
  buildClaudeCodeTurnPrompts,
  buildClaudePromptFromMessages,
  buildExternalStellaHistoryPromptMessage,
  getExternalEngineSessionId,
  setExternalEngineSessionId,
} from "../../../../../runtime/kernel/agent-runtime/external-engines.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { DatabaseSync } from "node:sqlite";

describe("claude-code-session-runtime", () => {
  const originalFetch = globalThis.fetch;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicOauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
    if (originalAnthropicOauthToken === undefined) {
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOauthToken;
    }
  });

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

  it("lists Claude Code aliases without endpoint credentials", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;

    const { models } = await listClaudeCodeModels({});

    expect(models.map((model) => model.id)).toEqual([
      "default",
      "best",
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "opusplan",
      "sonnet[1m]",
      "opus[1m]",
    ]);
    // Aliases surface friendly names + descriptions, not raw CLI tokens.
    const defaultOption = models.find((model) => model.id === "default");
    expect(defaultOption?.displayName).toBe("Default");
    expect(defaultOption?.description).toContain("Recommended");
    expect(models.find((model) => model.id === "opusplan")?.displayName).toBe(
      "Opus Plan",
    );
  });

  it("labels the default alias with the CLI-reported resolved model", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    const stellaAppDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-models-"),
    );
    try {
      await recordClaudeCodeResolvedModel(
        stellaAppDir,
        "default",
        "claude-opus-4-8[1m]",
      );
      const { models } = await listClaudeCodeModels({}, stellaAppDir);
      expect(models.find((model) => model.id === "default")?.displayName).toBe(
        "Default · Opus 4.8 (1M context)",
      );
    } finally {
      fs.rmSync(stellaAppDir, { recursive: true, force: true });
    }
  });

  it("merges Anthropic endpoint models into Claude Code aliases", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { models } = await listClaudeCodeModels({ apiKey: "sk-ant-test" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "sk-ant-test" }),
      }),
    );
    expect(models).toContainEqual({
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      source: "anthropic",
    });
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

  it("classifies refusal/overload CLI errors for the fable fallback policy", () => {
    // Refusal wording verified against CLI 2.1.32.
    expect(
      isClaudeCodeModelRefusalOrOverloadError(
        "API Error: Claude Code is unable to respond to this request, " +
          "which appears to violate our Usage Policy (https://...).",
      ),
    ).toBe(true);
    expect(
      isClaudeCodeModelRefusalOrOverloadError(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      ),
    ).toBe(true);
    expect(isClaudeCodeModelRefusalOrOverloadError("Prompt is too long")).toBe(
      false,
    );
    expect(
      isClaudeCodeModelRefusalOrOverloadError(
        "Claude Code process ended before delivering a result.",
      ),
    ).toBe(false);
  });

  it("detects the CLI's model-fallback announcement with pretty from/to names", () => {
    // Real shape (CLI 2.1.32): the fallback is announced as a
    // system/informational message, not a structured event.
    const fallback = getClaudeCodeModelFallbackFromStreamEvent({
      type: "system",
      subtype: "informational",
      content:
        "Model fallback triggered: switching from claude-fable-5 to claude-opus-4-8",
      level: "info",
      isMeta: false,
    });
    expect(fallback).not.toBeNull();
    expect(fallback?.fromModel).toBe("Fable 5");
    expect(fallback?.toModel).toBe("Opus 4.8");
    expect(fallback?.text).toContain("Fable 5");
    expect(fallback?.text).toContain("Opus 4.8");

    // 1M-context variants pretty-print too.
    expect(
      getClaudeCodeModelFallbackFromStreamEvent({
        type: "system",
        subtype: "informational",
        content:
          "Model fallback triggered: switching from claude-fable-5[1m] to claude-opus-4-8",
      })?.fromModel,
    ).toBe("Fable 5 (1M context)");

    // Wording that drops the model ids still detects the switch with safe
    // generic labels.
    const generic = getClaudeCodeModelFallbackFromStreamEvent({
      type: "system",
      subtype: "informational",
      content: "Model fallback triggered",
    });
    expect(generic?.fromModel).toBe("the configured model");
    expect(generic?.toModel).toBe("a fallback model");

    // Unrelated informational messages and other system events are ignored.
    expect(
      getClaudeCodeModelFallbackFromStreamEvent({
        type: "system",
        subtype: "informational",
        content: "Compacting conversation…",
      }),
    ).toBeNull();
    expect(
      getClaudeCodeModelFallbackFromStreamEvent({
        type: "system",
        subtype: "init",
        model: "claude-fable-5",
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
          delta: { type: "input_json_delta", partial_json: '{"type"' },
        },
      }),
    ).toBeNull();
  });

  describe("createClaudeCodeStreamEmitter", () => {
    const streamEvent = (event: Record<string, unknown>) => ({
      type: "stream_event",
      event,
    });
    const textDelta = (text: string) =>
      streamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      });
    const messageStart = () => streamEvent({ type: "message_start" });
    const textBlockStart = () =>
      streamEvent({
        type: "content_block_start",
        content_block: { type: "text", text: "" },
      });
    const structuredOutputStart = () =>
      streamEvent({
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "t1",
          name: "StructuredOutput",
          input: {},
        },
      });
    const jsonDelta = (partial: string) =>
      streamEvent({
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: partial },
      });
    const collect = () => {
      const chunks: string[] = [];
      const emit = createClaudeCodeStreamEmitter((chunk) => chunks.push(chunk));
      return { chunks, emit };
    };

    it("streams natural text deltas through unchanged", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(textBlockStart());
      emit(textDelta("Hello"));
      emit(textDelta(" world"));
      expect(chunks.join("")).toBe("Hello world");
    });

    it("injects a paragraph break at message boundaries that would fuse words", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(textBlockStart());
      emit(textDelta("First message ends here."));
      // Claude Code streams the next assistant message through the same
      // step emitter with no separator of its own.
      emit(messageStart());
      emit(textBlockStart());
      emit(textDelta("Second message starts here."));
      expect(chunks.join("")).toBe(
        "First message ends here.\n\nSecond message starts here.",
      );
    });

    it("does not inject a separator when one already exists", () => {
      const { chunks, emit } = collect();
      emit(textBlockStart());
      emit(textDelta("Ends with newline.\n"));
      emit(messageStart());
      emit(textBlockStart());
      emit(textDelta("Next paragraph."));
      expect(chunks.join("")).toBe("Ends with newline.\nNext paragraph.");

      const second = collect();
      second.emit(textBlockStart());
      second.emit(textDelta("Ends without whitespace."));
      second.emit(messageStart());
      second.emit(textBlockStart());
      second.emit(textDelta(" starts with space"));
      expect(second.chunks.join("")).toBe(
        "Ends without whitespace. starts with space",
      );
    });

    it("streams the decoded final message from StructuredOutput input deltas", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(structuredOutputStart());
      emit(jsonDelta(""));
      emit(jsonDelta('{"type": "final'));
      emit(jsonDelta('", "message": "Paris is'));
      emit(jsonDelta(" rainy.\\nBring an umbrella \\u2602"));
      emit(jsonDelta('"}'));
      expect(chunks.join("")).toBe("Paris is rainy.\nBring an umbrella ☂");
    });

    it("emits a message-first structured final once the trailing type confirms it", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(structuredOutputStart());
      emit(jsonDelta('{"message": "Par'));
      emit(jsonDelta('is is rainy."'));
      // Nothing may stream before the payload is known to be final.
      expect(chunks).toEqual([]);
      emit(jsonDelta(', "type": "final"}'));
      expect(chunks.join("")).toBe("Paris is rainy.");
    });

    it("does not leak a message-first tool request's message field", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(structuredOutputStart());
      emit(jsonDelta('{"message": "Checking the weather."'));
      emit(
        jsonDelta(
          ', "type": "tool_request", "toolName": "get_weather", "args": {}}',
        ),
      );
      expect(chunks).toEqual([]);
    });

    it("emits nothing for structured tool requests", () => {
      const { chunks, emit } = collect();
      emit(structuredOutputStart());
      emit(jsonDelta('{"type": "tool_request", "toolName": "get_weather"'));
      emit(jsonDelta(', "args": {"city": "Paris"}}'));
      expect(chunks).toEqual([]);
    });

    it("mutes the structured restatement after a natural-text answer already streamed", () => {
      const { chunks, emit } = collect();
      emit(messageStart());
      emit(textBlockStart());
      emit(textDelta("The answer, streamed naturally."));
      emit(messageStart());
      emit(structuredOutputStart());
      emit(jsonDelta('{"type": "final", "message": "The answer, restated."}'));
      expect(chunks.join("")).toBe("The answer, streamed naturally.");
    });

    it("streams the message from a text step that is itself a final decision payload", () => {
      const { chunks, emit } = collect();
      emit(textBlockStart());
      emit(textDelta('{"type":"fin'));
      emit(textDelta('al","message":"Decoded from'));
      emit(textDelta(' text JSON."}'));
      expect(chunks.join("")).toBe("Decoded from text JSON.");
    });

    it("suppresses non-final JSON text steps entirely", () => {
      const { chunks, emit } = collect();
      emit(textBlockStart());
      emit(textDelta('{"type":"tool_request","toolName":"x","args":{}}'));
      expect(chunks).toEqual([]);
    });

    it("holds back split surrogate pairs until they complete", () => {
      const { chunks, emit } = collect();
      emit(structuredOutputStart());
      emit(jsonDelta('{"type": "final", "message": "emoji \\ud83d'));
      expect(chunks.join("")).toBe("emoji ");
      emit(jsonDelta('\\ude00 done"}'));
      expect(chunks.join("")).toBe("emoji 😀 done");
    });
  });

  it("builds Stella inline image tool results with image bytes and no raw markers", async () => {
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

      expect(prompt.text).toContain("Tool result attachments:");
      expect(prompt.text).toContain("image/png");
      expect(prompt.text).toContain("visible tree");
      expect(prompt.text).not.toContain("[stella-attach-image]");
      expect(prompt.images).toEqual([
        expect.objectContaining({
          type: "image",
          mimeType: "image/png",
          data: fs.readFileSync(imagePath).toString("base64"),
        }),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("collectClaudeCodeNativeFileChanges", () => {
    const assistantToolUse = (
      blocks: Array<Record<string, unknown>>,
    ): Record<string, unknown> => ({
      type: "assistant",
      message: { role: "assistant", content: blocks },
    });

    it("collects Write/Edit/MultiEdit/NotebookEdit file paths", () => {
      expect(
        collectClaudeCodeNativeFileChanges(
          assistantToolUse([
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/a.txt", content: "x" },
            },
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: "/tmp/b.ts",
                old_string: "a",
                new_string: "b",
              },
            },
            {
              type: "tool_use",
              name: "MultiEdit",
              input: { file_path: "/tmp/c.ts", edits: [] },
            },
            {
              type: "tool_use",
              name: "NotebookEdit",
              input: { notebook_path: "/tmp/d.ipynb" },
            },
          ]),
        ),
      ).toEqual([
        { path: "/tmp/a.txt", kind: { type: "add" } },
        { path: "/tmp/b.ts", kind: { type: "update" } },
        { path: "/tmp/c.ts", kind: { type: "update" } },
        { path: "/tmp/d.ipynb", kind: { type: "update" } },
      ]);
    });

    it("ignores non-file tools, missing paths, and non-assistant events", () => {
      expect(
        collectClaudeCodeNativeFileChanges(
          assistantToolUse([
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "touch /tmp/e.txt" },
            },
            {
              type: "tool_use",
              name: "StructuredOutput",
              input: { type: "final", message: "done" },
            },
            { type: "tool_use", name: "Write", input: { content: "no path" } },
            { type: "text", text: "hello" },
          ]),
        ),
      ).toEqual([]);
      expect(
        collectClaudeCodeNativeFileChanges({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_use",
                name: "Write",
                input: { file_path: "/tmp/f.txt" },
              },
            ],
          },
        }),
      ).toEqual([]);
    });
  });

  it("surfaces vanilla-mode native file writes on the turn result", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-files-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "function emit(payload) {",
        "  process.stdout.write(JSON.stringify(payload) + '\\n');",
        "}",
        "function handle(line) {",
        "  emit({",
        "    type: 'assistant',",
        "    session_id: 'fake-session',",
        "    message: { role: 'assistant', content: [",
        "      { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/report.html', content: '<html/>' } },",
        "      { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/report.html', content: '<html/>' } },",
        "      { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/notes.md', old_string: 'a', new_string: 'b' } },",
        "    ] },",
        "  });",
        "  emit({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "    result: 'Wrote the report.',",
        "  });",
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
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-files-1",
        sessionKey: `test-files:${Date.now()}`,
        prompt: "Write the report.",
        modelId: "claude-code/fable",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Wrote the report.");
      expect(result.fileChanges).toEqual([
        { path: "/tmp/report.html", kind: { type: "add" } },
        { path: "/tmp/notes.md", kind: { type: "update" } },
      ]);
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a Claude Code stream open and sends tool screenshot bytes as an image block", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-fake-claude-"));
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "prompts.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    const screenshotPath = path.join(dir, "computer use screenshot.png");
    const screenshotBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
      "base64",
    );
    fs.writeFileSync(screenshotPath, screenshotBytes);
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
        executeTool: async () => ({
          result:
            "visible tree\n" +
            `[stella-attach-image] inline=image/png path=${JSON.stringify(screenshotPath)}`,
        }),
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              argv: string[];
              content:
                | string
                | Array<{
                    type: string;
                    text?: string;
                    source?: { type: string; media_type: string; data: string };
                  }>;
            },
        );
      expect(result.text).toBe("Done from fake Claude.");
      expect(records).toHaveLength(2);
      expect(records[0]?.argv).toContain("--input-format");
      expect(records[0]?.argv).toContain("stream-json");
      expect(records[0]?.argv).not.toContain("--model");
      expect(records[0]?.content).toContain("Please read a.txt.");
      expect(records[1]?.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("visible tree"),
        }),
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: screenshotBytes.toString("base64"),
          },
        },
      ]);
      expect(JSON.stringify(records[1]?.content)).not.toContain(
        "[stella-attach-image]",
      );
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

  it("restarts the CLI process when the model or effort changes mid-session", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-model-change-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "prompts.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "let buffer = '';",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({",
        "    pid: process.pid,",
        "    argv: process.argv.slice(2),",
        "    effortEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,",
        "    content: parsed.message.content,",
        "  }) + '\\n');",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    result: 'Done.',",
        "  }) + '\\n');",
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
      const sessionKey = `test-model-change:${Date.now()}`;
      const baseRequest = {
        sessionKey,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      };
      await runClaudeCodeTurn({
        ...baseRequest,
        runId: "run-1",
        prompt: "First turn.",
        modelId: "claude-code/sonnet",
      });
      // Same session, new model: the streaming process must restart with
      // the new --model (resuming the same CLI conversation).
      await runClaudeCodeTurn({
        ...baseRequest,
        runId: "run-2",
        prompt: "Second turn.",
        modelId: "claude-code/opus",
      });
      // Unchanged config: the process is reused, not respawned.
      await runClaudeCodeTurn({
        ...baseRequest,
        runId: "run-3",
        prompt: "Third turn.",
        modelId: "claude-code/opus",
      });
      // Effort change alone also forces a restart (env-var config).
      await runClaudeCodeTurn({
        ...baseRequest,
        runId: "run-4",
        prompt: "Fourth turn.",
        modelId: "claude-code/opus",
        effortLevel: "high",
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              argv: string[];
              effortEnv: string | null;
            },
        );
      expect(records).toHaveLength(4);
      expect(records[0]?.argv).toContain("sonnet");
      expect(records[0]?.argv).not.toContain("--resume");

      expect(records[1]?.pid).not.toBe(records[0]?.pid);
      const modelIndex = records[1]!.argv.indexOf("--model");
      expect(records[1]?.argv[modelIndex + 1]).toBe("opus");
      expect(records[1]?.argv).toContain("--resume");
      expect(records[1]?.argv).toContain("fake-session");

      expect(records[2]?.pid).toBe(records[1]?.pid);

      expect(records[3]?.pid).not.toBe(records[2]?.pid);
      expect(records[3]?.effortEnv).toBe("high");
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

  it("streams preamble text and decoded structured final messages across tool steps", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-stream-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "let count = 0;",
        "function emit(payload) {",
        "  process.stdout.write(JSON.stringify(payload) + '\\n');",
        "}",
        "function streamEvent(event) {",
        "  emit({ type: 'stream_event', session_id: 'fake-session', event });",
        "}",
        "function handle(line) {",
        "  count += 1;",
        "  if (count === 1) {",
        "    streamEvent({ type: 'message_start' });",
        "    streamEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } });",
        "    streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking the weather.' } });",
        "    streamEvent({ type: 'message_start' });",
        "    streamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'StructuredOutput', input: {} } });",
        '    streamEvent({ type: \'content_block_delta\', delta: { type: \'input_json_delta\', partial_json: \'{"type": "tool_request", "toolName": "get_weather", "args": {"city": "Paris"}}\' } });',
        "    emit({ type: 'result', session_id: 'fake-session', is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { type: 'tool_request', toolName: 'get_weather', args: { city: 'Paris' } } });",
        "    return;",
        "  }",
        "  streamEvent({ type: 'message_start' });",
        "  streamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', id: 't2', name: 'StructuredOutput', input: {} } });",
        '  streamEvent({ type: \'content_block_delta\', delta: { type: \'input_json_delta\', partial_json: \'{"type": "final", "message": "Paris is\' } });',
        "  streamEvent({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ' 7\\u00b0C with light rain.\"}' } });",
        "  emit({ type: 'result', session_id: 'fake-session', is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { type: 'final', message: 'Paris is 7\\u00b0C with light rain.' } });",
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
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const chunks: string[] = [];
      const result = await runClaudeCodeTurn({
        runId: "run-stream-1",
        sessionKey: `test-stream:${Date.now()}`,
        prompt: "What's the weather in Paris?",
        modelId: "claude-code/default",
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object" },
          },
        ],
        onStream: (chunk) => chunks.push(chunk),
        executeTool: async () => ({ result: "7C light rain" }),
      });

      expect(result.text).toBe("Paris is 7°C with light rain.");
      // The step-1 preamble streams; the tool-request payload stays silent.
      expect(chunks[0]).toBe("Checking the weather.");
      // The step-2 structured final message streams incrementally instead of
      // popping in whole at result time.
      expect(chunks.slice(1)).toEqual(["Paris is", " 7°C with light rain."]);
      expect(chunks.join("")).not.toContain("tool_request");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs vanilla Claude Code untouched for per-spawn engine selections", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-vanilla-"),
    );
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
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({",
        "    argv: process.argv.slice(2),",
        "    content: parsed.message.content,",
        "  }) + '\\n');",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        '    result: \'{\\"final\\": \\"answer that looks like JSON\\"}\',',
        "  }) + '\\n');",
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
        runId: "run-vanilla-1",
        sessionKey: `test-vanilla:${Date.now()}`,
        prompt: "Fix the failing test in the repo.",
        modelId: "claude-code/opus",
        vanilla: true,
        systemPrompt: "Stella system prompt that must NOT be forwarded.",
        tools: [
          {
            name: "Read",
            description: "Read a file",
            parameters: { type: "object" },
          },
        ],
        executeTool: async () => {
          throw new Error("Stella tools must not be invoked in vanilla mode.");
        },
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; content: string });
      // Vanilla answers pass through verbatim — even JSON-looking text is the
      // final answer, never a structured Stella decision.
      expect(result.text).toBe('{"final": "answer that looks like JSON"}');
      expect(records).toHaveLength(1);
      const argv = records[0]?.argv ?? [];
      // Stock Claude Code: no built-in-tool strip, no Stella decision schema,
      // no MCP override, no injected system prompt.
      expect(argv).toContain("--dangerously-skip-permissions");
      expect(argv).toContain("--model");
      expect(argv).toContain("opus");
      expect(argv).not.toContain("--tools");
      expect(argv).not.toContain("--json-schema");
      expect(argv).not.toContain("--system-prompt");
      expect(argv).not.toContain("--mcp-config");
      expect(argv).not.toContain("--strict-mcp-config");
      expect(argv).not.toContain("--disable-slash-commands");
      expect(records[0]?.content).toContain(
        "Fix the failing test in the repo.",
      );
      expect(records[0]?.content).not.toContain("must NOT be forwarded");
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

  it("does not time out while a vanilla Claude Code native tool is in progress", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-long-native-tool-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "const emit = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');",
        "function handle() {",
        "  emit({ type: 'assistant', session_id: 'fake-session', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-long', name: 'Bash', input: { command: 'sleep 60' } }] } });",
        "  setTimeout(() => {",
        "    emit({ type: 'user', session_id: 'fake-session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-long', content: 'done' }] } });",
        "    emit({ type: 'result', session_id: 'fake-session', is_error: false, result: 'native command finished' });",
        "  }, 60);",
        "}",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  if (buffer.includes('\\n')) { buffer = ''; handle(); }",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousTimeout = process.env.STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS = "25";
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-long-native-tool",
        sessionKey: `test-long-native-tool:${Date.now()}`,
        prompt: "wait for the command",
        modelId: "claude-code/fable",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });
      expect(result.text).toBe("native command finished");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      if (previousTimeout === undefined) {
        delete process.env.STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_CLAUDE_CODE_IDLE_TIMEOUT_MS = previousTimeout;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps vanilla and takeover Claude Code persisted session ids separate", () => {
    const values = new Map<string, string>();
    const store = {
      getThreadExternalSessionId: (threadKey: string) => values.get(threadKey),
      setThreadExternalSessionId: (threadKey: string, value: string) => {
        values.set(threadKey, value);
      },
    } as unknown as Parameters<typeof getExternalEngineSessionId>[0]["store"];

    setExternalEngineSessionId({
      store,
      threadKey: "thread-1",
      engine: "claude_code_local_vanilla",
      sessionId: "vanilla-session",
    });
    expect(
      getExternalEngineSessionId({
        store,
        threadKey: "thread-1",
        engine: "claude_code_local_vanilla",
      }),
    ).toBe("vanilla-session");
    // A takeover run on the same thread must never resume the vanilla id.
    expect(
      getExternalEngineSessionId({
        store,
        threadKey: "thread-1",
        engine: "claude_code_local",
      }),
    ).toBeUndefined();

    setExternalEngineSessionId({
      store,
      threadKey: "thread-1",
      engine: "claude_code_local",
      sessionId: "takeover-session",
    });
    expect(
      getExternalEngineSessionId({
        store,
        threadKey: "thread-1",
        engine: "claude_code_local",
      }),
    ).toBe("takeover-session");
    // ...and the reverse holds once the takeover id overwrites the slot.
    expect(
      getExternalEngineSessionId({
        store,
        threadKey: "thread-1",
        engine: "claude_code_local_vanilla",
      }),
    ).toBeUndefined();
  });

  it("fails a vanilla Claude Code turn that returns an empty result", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-empty-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "function handle() {",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    result: '   ',",
        "  }) + '\\n');",
        "}",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    const line = buffer.slice(0, idx).trim();",
        "    buffer = buffer.slice(idx + 1);",
        "    if (line) handle();",
        "  }",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(
        runClaudeCodeTurn({
          runId: "run-vanilla-empty",
          sessionKey: `test-vanilla-empty:${Date.now()}`,
          prompt: "Do the task.",
          modelId: "claude-code/default",
          vanilla: true,
          tools: [],
          executeTool: async () => ({ result: "unused" }),
        }),
      ).rejects.toThrow("Claude Code returned an empty result.");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a step when the Claude Code process exits cleanly before its result", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-early-exit-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "spawns.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');",
        "const spawnCount = fs.readFileSync(logPath, 'utf8').trim().split('\\n').length;",
        "let buffer = '';",
        "function handle() {",
        "  if (spawnCount === 1) {",
        "    // Report a session id, then die cleanly without ever emitting a result.",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'system',",
        "      subtype: 'init',",
        "      session_id: 'fake-session',",
        "    }) + '\\n');",
        "    process.exit(0);",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "    structured_output: { type: 'final', message: 'Recovered fine.' },",
        "  }) + '\\n');",
        "}",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    const line = buffer.slice(0, idx).trim();",
        "    buffer = buffer.slice(idx + 1);",
        "    if (line) handle();",
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
        runId: "run-early-exit",
        sessionKey: `test-early-exit:${Date.now()}`,
        prompt: "Do the task.",
        modelId: "claude-code/default",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Recovered fine.");
      const spawns = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[] });
      expect(spawns).toHaveLength(2);
      // The respawn resumes the transcript the first process reported.
      expect(spawns[1]?.argv).toContain("--resume");
      expect(spawns[1]?.argv).toContain("fake-session");
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

  it("nudges the live session when Claude Code returns an invalid decision payload", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-bad-decision-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "prompts.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "let buffer = '';",
        "let count = 0;",
        "function handle(line) {",
        "  count += 1;",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({ count, content: parsed.message.content }) + '\\n');",
        "  if (count === 1) {",
        "    // Truncated decision, as observed in the wild: no toolName/args.",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'result',",
        "      session_id: 'fake-session',",
        "      is_error: false,",
        "      structured_output: { type: 'tool_request' },",
        "    }) + '\\n');",
        "    return;",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    structured_output: { type: 'final', message: 'Recovered decision.' },",
        "  }) + '\\n');",
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
        runId: "run-bad-decision",
        sessionKey: `test-bad-decision:${Date.now()}`,
        prompt: "Do the task.",
        modelId: "claude-code/default",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Recovered decision.");
      const prompts = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { count: number; content: string });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]?.content).toContain(
        "did not contain a valid Stella decision payload",
      );
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

  it("fails with an actionable message once the step recovery budget is exhausted", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-exhausted-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "spawns.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.STELLA_FAKE_CLAUDE_LOG, 'spawn\\n');",
        "let buffer = '';",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  if (buffer.includes('\\n')) process.exit(0);",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousLogPath = process.env.STELLA_FAKE_CLAUDE_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_FAKE_CLAUDE_LOG = logPath;
    try {
      await expect(
        runClaudeCodeTurn({
          runId: "run-exhausted",
          sessionKey: `test-exhausted:${Date.now()}`,
          prompt: "Do the task.",
          modelId: "claude-code/default",
          tools: [],
          executeTool: async () => ({ result: "unused" }),
        }),
      ).rejects.toThrow(
        /exited with code 0 before returning a result.*retried 2 time/s,
      );
      const spawns = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(spawns).toHaveLength(3);
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

  it("does not replay a step whose attempt already applied native file writes", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-mutated-exit-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "prompts.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "const spawnCount = (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\\n').length : 0) + 1;",
        "let buffer = '';",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({ spawnCount, content: parsed.message.content }) + '\\n');",
        "  if (spawnCount === 1) {",
        "    // Apply a native Edit, then die cleanly before the result line.",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'assistant',",
        "      session_id: 'fake-session',",
        "      message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/mutated.md' } }] },",
        "    }) + '\\n');",
        "    setTimeout(() => process.exit(0), 20);",
        "    return;",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fake-session',",
        "    is_error: false,",
        "    result: 'Reconciled without redoing edits.',",
        "  }) + '\\n');",
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
        runId: "run-mutated-exit",
        sessionKey: `test-mutated-exit:${Date.now()}`,
        prompt: "Apply the hardening edits.",
        modelId: "claude-code/default",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Reconciled without redoing edits.");
      // The interrupted attempt's file write still reaches the turn result.
      expect(result.fileChanges).toEqual([
        { path: "/tmp/mutated.md", kind: { type: "update" } },
      ]);
      const prompts = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { spawnCount: number; content: string },
        );
      expect(prompts).toHaveLength(2);
      // The retry must NOT replay the original (mutating) prompt.
      expect(prompts[1]?.content).not.toContain("Apply the hardening edits.");
      expect(prompts[1]?.content).toContain(
        "Do NOT redo, repeat, or revert any file operations",
      );
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

  it("keeps file writes observed on a malformed step across the nudge recovery", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-malformed-files-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "let count = 0;",
        "function emit(payload) {",
        "  process.stdout.write(JSON.stringify(payload) + '\\n');",
        "}",
        "function handle() {",
        "  count += 1;",
        "  if (count === 1) {",
        "    // A native Write lands, but the step's result comes back empty.",
        "    emit({",
        "      type: 'assistant',",
        "      session_id: 'fake-session',",
        "      message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/tmp/report.md' } }] },",
        "    });",
        "    emit({ type: 'result', session_id: 'fake-session', is_error: false, result: '   ' });",
        "    return;",
        "  }",
        "  emit({ type: 'result', session_id: 'fake-session', is_error: false, result: 'Recovered final answer.' });",
        "}",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    const line = buffer.slice(0, idx).trim();",
        "    buffer = buffer.slice(idx + 1);",
        "    if (line) handle();",
        "  }",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const result = await runClaudeCodeTurn({
        runId: "run-malformed-files",
        sessionKey: `test-malformed-files:${Date.now()}`,
        prompt: "Write the report.",
        modelId: "claude-code/default",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Recovered final answer.");
      // Files written during the malformed attempt are not dropped.
      expect(result.fileChanges).toEqual([
        { path: "/tmp/report.md", kind: { type: "add" } },
      ]);
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reseeds a mutated step through the reconciliation prompt when the resume session is missing", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-mutated-resume-loss-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "spawns.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "const spawnCount = (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\\n').filter(Boolean).length : 0) + 1;",
        "let buffer = '';",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({ spawnCount, argv: process.argv.slice(2), content: parsed.message.content }) + '\\n');",
        "  if (spawnCount === 1) {",
        "    // Apply a native Edit, then die cleanly before the result line.",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'system', subtype: 'init', session_id: 'mut-session',",
        "    }) + '\\n');",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'assistant',",
        "      session_id: 'mut-session',",
        "      message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/guarded.md' } }] },",
        "    }) + '\\n');",
        "    setTimeout(() => process.exit(0), 20);",
        "    return;",
        "  }",
        "  if (spawnCount === 2) {",
        "    // The on-disk transcript is gone: the --resume respawn fails.",
        "    process.stderr.write('No conversation found with session ID: mut-session\\n');",
        "    setTimeout(() => process.exit(1), 20);",
        "    return;",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fresh-after-loss',",
        "    is_error: false,",
        "    result: 'Reconciled after resume loss.',",
        "  }) + '\\n');",
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
        runId: "run-mutated-resume-loss",
        sessionKey: `test-mutated-resume-loss:${Date.now()}`,
        prompt: "Apply the guarded edit.",
        resumeFallbackPrompt:
          "<stella_thread_history>HISTORY SEED</stella_thread_history>\n\nApply the guarded edit.",
        modelId: "claude-code/default",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Reconciled after resume loss.");
      expect(result.fileChanges).toEqual([
        { path: "/tmp/guarded.md", kind: { type: "update" } },
      ]);
      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              spawnCount: number;
              argv: string[];
              content: string;
            },
        );
      expect(records).toHaveLength(3);
      expect(records[1]?.argv).toContain("--resume");
      expect(records[2]?.argv).not.toContain("--resume");
      // The reseed must reconcile, never replay the fallback wholesale.
      expect(
        records[2]?.content.startsWith("The previous step was interrupted"),
      ).toBe(true);
      expect(records[2]?.content).toContain(
        "Do NOT redo, repeat, or revert any file operations",
      );
      expect(records[2]?.content).toContain("/tmp/guarded.md");
      // Task context survives as reference-only material.
      expect(records[2]?.content).toContain("for reference only");
      expect(records[2]?.content).toContain("HISTORY SEED");
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

  it("reseeds a mutated step through the reconciliation prompt after a compaction loop", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-mutated-loop-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "spawns.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "const spawnCount = (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\\n').filter(Boolean).length : 0) + 1;",
        "let buffer = '';",
        "function emit(payload) {",
        "  process.stdout.write(JSON.stringify(payload) + '\\n');",
        "}",
        "function handle(line) {",
        "  const parsed = JSON.parse(line);",
        "  fs.appendFileSync(logPath, JSON.stringify({ spawnCount, argv: process.argv.slice(2), content: parsed.message.content }) + '\\n');",
        "  if (spawnCount === 1) {",
        "    // A native Edit lands, then the session compacts forever.",
        "    emit({",
        "      type: 'assistant',",
        "      session_id: 'loop-mut-session',",
        "      message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/looped.md' } }] },",
        "    });",
        "    for (let i = 0; i < 4; i += 1) {",
        "      emit({ type: 'system', subtype: 'status', status: 'compacting' });",
        "      emit({ type: 'system', subtype: 'hook_response', hook_event: 'PostCompact' });",
        "    }",
        "    setInterval(() => {}, 1000);",
        "    return;",
        "  }",
        "  emit({",
        "    type: 'result',",
        "    session_id: 'fresh-after-mut-loop',",
        "    is_error: false,",
        "    result: 'Recovered after loop.',",
        "  });",
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
        runId: "run-mutated-loop",
        sessionKey: `test-mutated-loop:${Date.now()}`,
        prompt: "Do the loop task.",
        resumeFallbackPrompt:
          "<stella_thread_history>LOOP SEED</stella_thread_history>\n\nDo the loop task.",
        modelId: "claude-code/default",
        vanilla: true,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      expect(result.text).toBe("Recovered after loop.");
      // The interrupted attempt's write survives onto the turn result.
      expect(result.fileChanges).toEqual([
        { path: "/tmp/looped.md", kind: { type: "update" } },
      ]);
      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              spawnCount: number;
              argv: string[];
              content: string;
            },
        );
      expect(records).toHaveLength(2);
      expect(records[1]?.argv).not.toContain("--resume");
      // The reseed reconciles instead of replaying resumeFallbackPrompt.
      expect(
        records[1]?.content.startsWith("The previous step was interrupted"),
      ).toBe(true);
      expect(records[1]?.content).toContain(
        "Do NOT redo, repeat, or revert any file operations",
      );
      expect(records[1]?.content).toContain("/tmp/looped.md");
      expect(records[1]?.content).toContain("for reference only");
      expect(records[1]?.content).toContain("LOOP SEED");
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

  it("keeps tracking the replacement process when a restart races the old close event", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-restart-race-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "let buffer = '';",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    buffer = buffer.slice(idx + 1);",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'result',",
        "      session_id: 'restart-session',",
        "      is_error: false,",
        "      structured_output: { type: 'final', message: 'ok' },",
        "    }) + '\\n');",
        "  }",
        "});",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    const sessionKey = `test-restart-race:${Date.now()}`;
    try {
      const baseRequest = {
        runId: "run-restart-race",
        sessionKey,
        prompt: "Say ok.",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      };
      // Turn 1 leaves an idle process behind…
      await runClaudeCodeTurn({
        ...baseRequest,
        modelId: "claude-code/sonnet",
      });
      // …turn 2's model change restarts it, registering a replacement child
      // under the same session key while the old child is still closing.
      const second = await runClaudeCodeTurn({
        ...baseRequest,
        modelId: "claude-code/opus",
      });
      expect(second.text).toBe("ok");
      // Let the old child's close event fire.
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The stale close handler must not evict the NEW child from tracking.
      expect(claudeCodeSessionHasActiveProcess(sessionKey)).toBe(true);
      // And the replacement still serves turns.
      const third = await runClaudeCodeTurn({
        ...baseRequest,
        modelId: "claude-code/opus",
      });
      expect(third.text).toBe("ok");
      scheduleClaudeCodeSessionCloseWhenIdle(sessionKey, 1_000);
      await vi.waitFor(
        () => {
          expect(claudeCodeSessionHasActiveProcess(sessionKey)).toBe(false);
        },
        { timeout: 2_000 },
      );
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes after an aborted Claude Code turn once a session id was observed", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-abort-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "abort.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "let buffer = '';",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "function log(payload) {",
        "  fs.appendFileSync(logPath, JSON.stringify(payload) + '\\n');",
        "}",
        "process.on('SIGINT', () => {",
        "  log({ event: 'sigint', argv: process.argv.slice(2) });",
        "  process.exit(130);",
        "});",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  for (;;) {",
        "    const idx = buffer.indexOf('\\n');",
        "    if (idx === -1) break;",
        "    const line = buffer.slice(0, idx).trim();",
        "    buffer = buffer.slice(idx + 1);",
        "    if (!line) continue;",
        "    const parsed = JSON.parse(line);",
        "    const argv = process.argv.slice(2);",
        "    log({",
        "      event: 'prompt',",
        "      argv,",
        "      payloadSessionId: parsed.session_id,",
        "      content: parsed.message.content,",
        "    });",
        "    process.stdout.write(JSON.stringify({",
        "      type: 'system',",
        "      subtype: 'init',",
        "      session_id: 'observed-session',",
        "    }) + '\\n');",
        "    if (argv.includes('--resume')) {",
        "      process.stdout.write(JSON.stringify({",
        "        type: 'result',",
        "        session_id: 'observed-session',",
        "        is_error: false,",
        "        structured_output: { type: 'final', message: 'Resumed after abort.' },",
        "        usage: { input_tokens: 1, output_tokens: 1 },",
        "      }) + '\\n');",
        "    }",
        "  }",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousLogPath = process.env.STELLA_FAKE_CLAUDE_LOG;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_FAKE_CLAUDE_LOG = logPath;
    try {
      const sessionKey = `test:abort:${Date.now()}`;
      const controller = new AbortController();
      const firstTurn = runClaudeCodeTurn({
        runId: "run-abort-1",
        sessionKey,
        prompt: "Start a long turn.",
        modelId: "claude-code/default",
        tools: [],
        abortSignal: controller.signal,
        executeTool: async () => ({ result: "unused" }),
      });

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const poll = () => {
          if (
            fs.existsSync(logPath) &&
            fs.readFileSync(logPath, "utf8").includes("prompt")
          ) {
            resolve();
            return;
          }
          if (Date.now() - startedAt > 2_000) {
            reject(new Error("Fake Claude did not receive the first prompt."));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      });
      controller.abort();
      await expect(firstTurn).rejects.toThrow("Claude Code run aborted");

      const result = await runClaudeCodeTurn({
        runId: "run-abort-2",
        sessionKey,
        prompt: "Follow-up after abort.",
        modelId: "claude-code/default",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              event: string;
              argv: string[];
              payloadSessionId?: string;
              content?: string;
            },
        );
      const prompts = records.filter((record) => record.event === "prompt");
      expect(result.text).toBe("Resumed after abort.");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]?.argv).not.toContain("--resume");
      expect(prompts[1]?.argv).toContain("--resume");
      expect(prompts[1]?.argv[prompts[1].argv.indexOf("--resume") + 1]).toBe(
        "observed-session",
      );
      expect(prompts[1]?.payloadSessionId).toBe("observed-session");
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

  it("fails a silent Claude Code process instead of hanging", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-silent-"),
    );
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    fs.chmodSync(fakeClaude, 0o755);
    const previousPath = process.env.PATH;
    const previousTimeout =
      process.env.STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS = "25";
    try {
      await expect(
        runClaudeCodeTurn({
          runId: "run-silent",
          sessionKey: `test:silent:${Date.now()}`,
          prompt: "Hello.",
          modelId: "claude-code/default",
          tools: [],
          executeTool: async () => ({ result: "unused" }),
        }),
      ).rejects.toThrow("Claude Code did not produce output");
    } finally {
      shutdownClaudeCodeRuntime();
      process.env.PATH = previousPath;
      if (previousTimeout === undefined) {
        delete process.env.STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_CLAUDE_CODE_STARTUP_IDLE_TIMEOUT_MS =
          previousTimeout;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh Claude Code session when the stored resume id is missing", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-resume-"),
    );
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

  it("keeps the Stella history out of resumed turn prompts", () => {
    const historyPromptMessage = {
      messageType: "message" as const,
      uiVisibility: "hidden" as const,
      customType: "runtime.stella_thread_history",
      text: '<stella_thread_history source="stella">\n<history_message index="1" role="user">\nEarlier request\n</history_message>\n</stella_thread_history>',
    };
    const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
      historyPromptMessage,
      promptMessages: [{ text: "What should I do next?" }],
      hasPersistedSession: true,
    });

    expect(prompt).toContain("What should I do next?");
    expect(prompt).not.toContain("<stella_thread_history");
    // A lost resume still reseeds the fresh session from the history.
    expect(resumeFallbackPrompt).toContain("<stella_thread_history");
    expect(resumeFallbackPrompt).toContain("What should I do next?");
  });

  it("seeds fresh Claude Code sessions with the Stella history", () => {
    const historyPromptMessage = {
      messageType: "message" as const,
      uiVisibility: "hidden" as const,
      customType: "runtime.stella_thread_history",
      text: '<stella_thread_history source="stella">\n<history_message index="1" role="assistant">\nEarlier answer\n</history_message>\n</stella_thread_history>',
    };
    const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
      historyPromptMessage,
      promptMessages: [{ text: "Continue the plan." }],
      hasPersistedSession: false,
    });

    expect(prompt).toContain("<stella_thread_history");
    expect(prompt).toContain("Continue the plan.");
    expect(resumeFallbackPrompt).toBe(prompt);

    const withoutHistory = buildClaudeCodeTurnPrompts({
      historyPromptMessage: null,
      promptMessages: [{ text: "Continue the plan." }],
      hasPersistedSession: false,
    });
    expect(withoutHistory.prompt).toContain("Continue the plan.");
    expect(withoutHistory.prompt).not.toContain("<stella_thread_history");
    expect(withoutHistory.resumeFallbackPrompt).toBeUndefined();
  });

  it("hydrates the Stella history block from compaction checkpoints, not raw disk history", () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-claude-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    try {
      initializeDesktopDatabase(db);
      const store = new SessionStore(db);
      const threadKey = "conversation-1:orchestrator:run-1";
      store.appendThreadMessage({
        threadKey,
        timestamp: 1_000,
        role: "user",
        content: "Original giant request",
        payload: {
          role: "user",
          content: "Original giant request",
          timestamp: 1_000,
        },
      });
      store.appendThreadMessage({
        threadKey,
        timestamp: 1_001,
        role: "assistant",
        content: "Original giant answer",
      });
      store.appendThreadMessage({
        threadKey,
        timestamp: 1_002,
        role: "user",
        content: "Latest request",
        payload: {
          role: "user",
          content: "Latest request",
          timestamp: 1_002,
        },
      });
      const rawMessages = store.loadThreadMessages(threadKey);
      expect(rawMessages).toHaveLength(3);
      store.compactThread({
        threadKey,
        summary: "Condensed earlier work",
        fromEntryId: rawMessages[0]!.entryId!,
        toEntryId: rawMessages[1]!.entryId!,
        tokensBefore: 1_234,
        timestamp: 1_100,
      });

      // The claude-code engine hydrates through the same overlay-applying
      // `loadThreadMessages` the native engine uses: pre-checkpoint messages
      // are replaced by the checkpoint summary.
      const threadHistory = store.loadThreadMessages(threadKey);
      const historyPromptMessage = buildExternalStellaHistoryPromptMessage({
        opts: {
          agentContext: { threadHistory },
        } as unknown as Parameters<
          typeof buildExternalStellaHistoryPromptMessage
        >[0]["opts"],
        promptMessages: [{ text: "What is next?" }],
      });

      expect(historyPromptMessage).not.toBeNull();
      expect(historyPromptMessage?.text).toContain("[[THREAD_CHECKPOINT]]");
      expect(historyPromptMessage?.text).toContain("Condensed earlier work");
      expect(historyPromptMessage?.text).toContain("Latest request");
      expect(historyPromptMessage?.text).not.toContain(
        "Original giant request",
      );
      expect(historyPromptMessage?.text).not.toContain("Original giant answer");
    } finally {
      db.close();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("forwards the auto-compaction budget to the Claude Code CLI environment", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-compact-env-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "env.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "let buffer = '';",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  const idx = buffer.indexOf('\\n');",
        "  if (idx === -1) return;",
        "  fs.appendFileSync(process.env.STELLA_FAKE_CLAUDE_LOG, JSON.stringify({",
        "    autoCompactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,",
        "    autoCompactPct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null,",
        "  }) + '\\n');",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'compact-env-session',",
        "    is_error: false,",
        "    structured_output: { type: 'final', message: 'ok' },",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "  }) + '\\n');",
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
        runId: "run-compact-env",
        sessionKey: `test:compact-env:${Date.now()}`,
        prompt: "Hello.",
        modelId: "claude-code/default",
        autoCompactWindowTokens: 80_000,
        autoCompactTriggerPct: 75,
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      const record = JSON.parse(
        fs.readFileSync(logPath, "utf8").trim().split("\n")[0]!,
      ) as { autoCompactWindow: string | null; autoCompactPct: string | null };
      expect(result.text).toBe("ok");
      expect(record.autoCompactWindow).toBe("80000");
      expect(record.autoCompactPct).toBe("75");
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

  it("breaks a Claude Code compaction loop by reseeding a fresh session from the fallback prompt", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-fake-claude-loop-"),
    );
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "loop.log");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeClaude = path.join(binDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const logPath = process.env.STELLA_FAKE_CLAUDE_LOG;",
        "const argv = process.argv.slice(2);",
        "let buffer = '';",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk.toString('utf8');",
        "  const idx = buffer.indexOf('\\n');",
        "  if (idx === -1) return;",
        "  const parsed = JSON.parse(buffer.slice(0, idx));",
        "  fs.appendFileSync(logPath, JSON.stringify({ argv, content: parsed.message.content }) + '\\n');",
        "  if (argv.includes('--resume')) {",
        "    for (let i = 0; i < 4; i += 1) {",
        "      process.stdout.write(JSON.stringify({",
        "        type: 'system', subtype: 'status', status: 'compacting',",
        "      }) + '\\n');",
        "      process.stdout.write(JSON.stringify({",
        "        type: 'system', subtype: 'hook_response', hook_event: 'PostCompact',",
        "      }) + '\\n');",
        "    }",
        "    setInterval(() => {}, 1000);",
        "    return;",
        "  }",
        "  process.stdout.write(JSON.stringify({",
        "    type: 'result',",
        "    session_id: 'fresh-after-loop',",
        "    is_error: false,",
        "    structured_output: { type: 'final', message: 'Recovered after loop.' },",
        "    usage: { input_tokens: 1, output_tokens: 1 },",
        "  }) + '\\n');",
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
        runId: "run-loop",
        sessionKey: `test:loop:${Date.now()}`,
        persistedSessionId: "looping-session",
        prompt: "Continue the plan.",
        resumeFallbackPrompt:
          "<stella_thread_history>Checkpoint summary seed</stella_thread_history>\n\nContinue the plan.",
        modelId: "claude-code/default",
        tools: [],
        executeTool: async () => ({ result: "unused" }),
      });

      const records = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; content: string });
      expect(result.text).toBe("Recovered after loop.");
      expect(result.sessionId).toBe("fresh-after-loop");
      expect(records).toHaveLength(2);
      expect(records[0]?.argv).toContain("--resume");
      expect(records[0]?.content).not.toContain("<stella_thread_history>");
      expect(records[1]?.argv).not.toContain("--resume");
      expect(records[1]?.content).toContain("Checkpoint summary seed");
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
});
