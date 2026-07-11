import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Capture calls into the Claude Code agent runtime so we can assert the
// one-shot pipeline reaches the local engine without any resolvable route.
const claudeCodeCalls: Array<Record<string, unknown>> = [];
let claudeCodeEngineActive = false;
const closedSessionKeys: string[] = [];
const scheduledSessionCloses: Array<{ sessionKey: string; timeoutMs: number }> =
  [];

vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js",
  () => ({
    shouldUseClaudeCodeAgentRuntime: () => claudeCodeEngineActive,
    runClaudeCodeAgentTextCompletion: async (args: Record<string, unknown>) => {
      claudeCodeCalls.push(args);
      return "summarizing agent progress now";
    },
  }),
);

vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js",
  () => ({
    closeClaudeCodeSessionWhenIdle: (sessionKey: string) => {
      closedSessionKeys.push(sessionKey);
    },
    scheduleClaudeCodeSessionCloseWhenIdle: (
      sessionKey: string,
      timeoutMs: number,
    ) => {
      scheduledSessionCloses.push({ sessionKey, timeoutMs });
    },
  }),
);

const completeSimpleCalls: Array<Record<string, unknown>> = [];
vi.mock("../../../../../runtime/ai/stream.js", () => ({
  completeSimple: async (model: unknown) => {
    completeSimpleCalls.push({ model });
    return { content: [{ type: "text", text: "relay summary" }] };
  },
  readAssistantText: () => "relay summary",
}));

import { runOneShotCompletion } from "../../../../../runtime/kernel/agent-runtime/one-shot-completion.js";

const makeRuntime = (args: { authToken: string | null; dataDir: string }) => ({
  stellaAppDir: "/tmp/does-not-matter-app-dir",
  stellaDataDir: args.dataDir,
  siteBaseUrl: args.authToken ? "https://site.example.test" : null,
  getAuthToken: () => args.authToken,
  hasConnectedAccount: () => Boolean(args.authToken),
});

const request = {
  agentType: "progress_summary",
  model: "stella/light",
  fallbackAgentTypes: ["general"],
  systemPrompt: "narrate",
  userText: "Task: test\nCurrent activity: working",
  maxOutputTokens: 24,
  temperature: 0.4,
};

let dataDir: string;

beforeEach(() => {
  claudeCodeCalls.length = 0;
  completeSimpleCalls.length = 0;
  closedSessionKeys.length = 0;
  scheduledSessionCloses.length = 0;
  claudeCodeEngineActive = false;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-shot-test-"));
});

describe("runOneShotCompletion", () => {
  it("uses the Claude Code engine when no LLM route resolves (signed-out CC user)", async () => {
    claudeCodeEngineActive = true;
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(result.text).toBe("summarizing agent progress now");
    expect(claudeCodeCalls).toHaveLength(1);
    // The explicit stella/light pin must flow through so CC maps it to Haiku.
    expect(claudeCodeCalls[0]?.stellaModel).toBe("stella/light");
    expect(completeSimpleCalls).toHaveLength(0);
  });

  it("splits CC preferences (data dir) from the CLI working directory (app dir)", async () => {
    claudeCodeEngineActive = true;
    await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(claudeCodeCalls).toHaveLength(1);
    // Preferences (claudeCodeModel, effort) resolve against the data dir…
    expect(claudeCodeCalls[0]?.stellaAppDir).toBe(dataDir);
    // …while the CLI runs in the app dir, never inside the data dir.
    expect(claudeCodeCalls[0]?.cwd).toBe("/tmp/does-not-matter-app-dir");
  });

  it("reuses and closes an explicitly lifecycle-scoped Claude session", async () => {
    claudeCodeEngineActive = true;
    const persistentRequest = {
      ...request,
      sessionKey: "progress-summary:agent-1",
      sessionIdleTtlMs: 60_000,
    };
    await runOneShotCompletion({
      request: persistentRequest,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(claudeCodeCalls[0]?.sessionKey).toBe("progress-summary:agent-1");
    expect(scheduledSessionCloses).toEqual([
      { sessionKey: "progress-summary:agent-1", timeoutMs: 60_000 },
    ]);

    await runOneShotCompletion({
      request: {
        agentType: "progress_summary",
        userText: "",
        sessionKey: "progress-summary:agent-1",
        closeSession: true,
      },
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(closedSessionKeys).toEqual(["progress-summary:agent-1"]);
    expect(claudeCodeCalls).toHaveLength(1);
  });

  it("still fails loudly when signed out on the native engine", async () => {
    await expect(
      runOneShotCompletion({
        request,
        runtime: makeRuntime({ authToken: null, dataDir }),
      }),
    ).rejects.toThrow();
    expect(claudeCodeCalls).toHaveLength(0);
  });
});
