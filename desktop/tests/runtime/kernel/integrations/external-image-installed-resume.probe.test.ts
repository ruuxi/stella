import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import {
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js";
import {
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
} from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import type { ToolMetadata } from "../../../../../runtime/kernel/tools/types.js";

const RUN_INSTALLED_PROBE =
  process.env.STELLA_RUN_INSTALLED_EXTERNAL_IMAGE_RESUME_PROBE === "1";
const imageTool: ToolMetadata = {
  name: "image_gen",
  description:
    "Generate an image. This probe returns a mocked terminal result and never contacts an image provider.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const terminalToolResult = {
  result: JSON.stringify({
    ok: true,
    job: {
      jobId: "probe-mocked-image-job",
      status: "succeeded",
      capability: "text_to_image",
      profile: "best",
    },
    filePaths: ["/tmp/probe-mocked-image.png"],
    artifacts: [],
    reattached: false,
  }),
};

const nativeId = (durableId: string): string =>
  durableId.split(":").slice(2, -1).join(":");
const durableScope = (durableId: string): string => durableId.split(":")[1]!;

const installedVersion = (binary: string): string =>
  execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const capture: Record<string, unknown> = {};

describe.skipIf(!RUN_INSTALLED_PROBE)(
  "installed external image resume certification probe",
  () => {
    afterAll(() => {
      shutdownClaudeCodeRuntime();
      shutdownCodexAppServerRuntime();
      const outputPath = process.env.STELLA_EXTERNAL_IMAGE_PROBE_CAPTURE;
      if (outputPath) {
        fs.writeFileSync(outputPath, `${JSON.stringify(capture, null, 2)}\n`, {
          mode: 0o600,
        });
      }
    });

    it("uses Claude's persisted tool_use.id across a real CLI resume", async () => {
      const cwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "stella-installed-claude-image-probe-"),
      );
      const calls: string[] = [];
      const protocolInits: Array<{
        tools: string[];
        mcpServers: Array<{ name?: string; status?: string }>;
      }> = [];
      try {
        const sessionKey = `installed-claude-image-probe:${Date.now()}`;
        const first = await runClaudeCodeTurn({
          runId: "installed-claude-image-probe-first",
          sessionKey,
          prompt:
            'Use the available image_gen tool exactly once with {"prompt":"installed resume identity probe"}.',
          modelId: "claude-code/default",
          cwd,
          tools: [imageTool],
          onProtocolInit: (init) => protocolInits.push(init),
          executeTool: async (toolCallId) => {
            calls.push(toolCallId);
            return terminalToolResult;
          },
        }).catch((error) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} (observed image tool calls: ${calls.length}; init: ${JSON.stringify(protocolInits)})`,
          );
        });
        expect(calls, JSON.stringify(protocolInits)).toHaveLength(1);

        shutdownClaudeCodeRuntime();
        const resumed = await runClaudeCodeTurn({
          runId: "installed-claude-image-probe-resumed",
          sessionKey,
          persistedSessionId: first.sessionId,
          prompt:
            'This is a new intentional invocation. Use image_gen exactly once again with {"prompt":"installed resume identity probe"}.',
          modelId: "claude-code/default",
          cwd,
          tools: [imageTool],
          onProtocolInit: (init) => protocolInits.push(init),
          executeTool: async (toolCallId) => {
            calls.push(toolCallId);
            return terminalToolResult;
          },
        });
        expect(resumed.sessionId).toBe(first.sessionId);
        expect(calls).toHaveLength(2);
        expect(nativeId(calls[1]!)).not.toBe(nativeId(calls[0]!));
        expect(durableScope(calls[1]!)).toBe(durableScope(calls[0]!));

        capture.claude = {
          version: installedVersion("claude"),
          sessionContinuity: resumed.sessionId === first.sessionId,
          nativeToolUseIds: calls.map(nativeId),
          durableScopes: calls.map(durableScope),
          protocolInits,
        };
      } finally {
        shutdownClaudeCodeRuntime();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }, 180_000);

    it("uses Codex's persisted dynamicToolCall.id across a real app-server resume", async () => {
      const cwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "stella-installed-codex-image-probe-"),
      );
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "stella-installed-codex-data-"),
      );
      const calls: string[] = [];
      try {
        const sessionKey = `installed-codex-image-probe:${Date.now()}`;
        const first = await runCodexAgentTurn({
          runId: "installed-codex-image-probe-first",
          sessionKey,
          prompt:
            'Invoke image_gen exactly once with {"prompt":"installed resume identity probe"}. The tool is mocked; after it returns, reply only CODEX_FIRST_DONE.',
          cwd,
          stellaDataDir: dataDir,
          tools: [imageTool],
          executeTool: async (toolCallId) => {
            calls.push(toolCallId);
            return terminalToolResult;
          },
          reuseAppServer: true,
        });
        expect(first.text).toContain("CODEX_FIRST_DONE");
        expect(calls).toHaveLength(1);

        shutdownCodexAppServerRuntime();
        const resumed = await runCodexAgentTurn({
          runId: "installed-codex-image-probe-resumed",
          sessionKey,
          persistedSessionId: first.sessionId,
          prompt:
            'This is a new intentional invocation. Invoke image_gen exactly once again with {"prompt":"installed resume identity probe"}, then reply only CODEX_RESUMED_DONE.',
          cwd,
          stellaDataDir: dataDir,
          tools: [imageTool],
          executeTool: async (toolCallId) => {
            calls.push(toolCallId);
            return terminalToolResult;
          },
          reuseAppServer: true,
        });
        expect(resumed.sessionId).toBe(first.sessionId);
        expect(resumed.text).toContain("CODEX_RESUMED_DONE");
        expect(calls).toHaveLength(2);
        expect(nativeId(calls[1]!)).not.toBe(nativeId(calls[0]!));
        expect(durableScope(calls[1]!)).toBe(durableScope(calls[0]!));

        capture.codex = {
          version: installedVersion("codex"),
          sessionContinuity: resumed.sessionId === first.sessionId,
          nativeDynamicToolCallIds: calls.map(nativeId),
          durableScopes: calls.map(durableScope),
        };
      } finally {
        shutdownCodexAppServerRuntime();
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
