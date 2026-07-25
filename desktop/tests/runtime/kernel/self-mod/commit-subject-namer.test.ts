/**
 * The self-mod commit-subject namer.
 *
 * The subject is derived text, so it runs as one stateless completion on the
 * engine-aware light tier instead of a hidden agent turn. These tests pin the
 * two properties that made that possible: the prompt is self-contained (so no
 * thread history has to be re-sent), and every failure degrades to the
 * finalizer's task-description fallback rather than blocking the commit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimpleCalls: Array<{
  model: unknown;
  context: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];
let completeSimpleResult: Record<string, unknown> = {
  content: [{ type: "text", text: "Add a panel to the home screen" }],
};

vi.mock("../../../../../runtime/ai/stream.js", () => ({
  completeSimple: async (
    model: unknown,
    context: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    completeSimpleCalls.push({ model, context, options });
    return completeSimpleResult;
  },
  readAssistantText: (message: { content?: Array<{ text?: string }> }) =>
    (message.content ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
}));

const claudeCodeCalls: Array<Record<string, unknown>> = [];
vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js",
  () => ({
    runClaudeCodeAgentTextCompletion: async (args: Record<string, unknown>) => {
      claudeCodeCalls.push(args);
      return "  Rename the sidebar toggle  ";
    },
  }),
);

import {
  COMMIT_SUBJECT_MAX_OUTPUT_TOKENS,
  buildCommitSubjectPrompt,
  createCommitSubjectProvider,
} from "../../../../../runtime/kernel/self-mod/feature-namer.js";
import { runLightTextCompletion } from "../../../../../runtime/kernel/agent-runtime/light-completion.js";

const input = {
  taskDescription: "Add a settings panel",
  files: ["desktop/src/panel.tsx", "desktop/src/index.ts"],
  diffPreview: "+export const Panel = () => null;",
  conversationId: "conv-1",
};

beforeEach(() => {
  completeSimpleCalls.length = 0;
  claudeCodeCalls.length = 0;
  completeSimpleResult = {
    content: [{ type: "text", text: "Add a panel to the home screen" }],
  };
});

describe("createCommitSubjectProvider", () => {
  it("passes exactly the self-contained prompt and nothing else", async () => {
    const prompts: string[] = [];
    const provider = createCommitSubjectProvider(async (prompt) => {
      prompts.push(prompt);
      return "Add a settings panel to the sidebar";
    });

    const subject = await provider(input);

    expect(subject).toBe("Add a settings panel to the sidebar");
    expect(prompts).toHaveLength(1);
    // The provider is handed a single string — there is no seam through
    // which thread history, tool results, or prior messages could travel.
    expect(prompts[0]).toBe(buildCommitSubjectPrompt(input));
    expect(prompts[0]).toContain("Add a settings panel");
    expect(prompts[0]).toContain("desktop/src/panel.tsx");
    expect(prompts[0]).toContain("+export const Panel = () => null;");
  });

  it("truncates an over-long subject to the 12-word ceiling", async () => {
    const provider = createCommitSubjectProvider(async () =>
      Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "),
    );

    const subject = await provider(input);

    expect(subject?.split(" ")).toHaveLength(12);
    expect(subject?.endsWith("…")).toBe(true);
  });

  it("returns null for an empty reply so the finalizer falls back", async () => {
    for (const reply of ["", "   ", null]) {
      const provider = createCommitSubjectProvider(async () => reply);
      expect(await provider(input)).toBeNull();
    }
  });

  it("propagates a provider failure to the finalizer's fallback", async () => {
    const provider = createCommitSubjectProvider(async () => {
      throw new Error("light tier unavailable");
    });

    // `StoreModService.deriveCommitSubject` catches this and uses the run's
    // task description; the commit still lands with its trailers.
    await expect(provider(input)).rejects.toThrow("light tier unavailable");
  });
});

describe("runLightTextCompletion", () => {
  const nativeRoute = {
    activeEngine: "stella" as const,
    executionEngine: "native" as const,
    modelId: "stella/deepseek/deepseek-v4-flash",
    resolvedLlm: {
      model: { id: "deepseek-v4-flash", provider: "stella", api: "openai" },
      getApiKey: async () => "key-123",
    },
  };

  it("sends one stateless user message on the resolved light model", async () => {
    const text = await runLightTextCompletion({
      route: nativeRoute as never,
      userPrompt: buildCommitSubjectPrompt(input),
      agentType: "general",
      stellaAppDir: "/tmp/app",
      stellaDataDir: "/tmp/data",
      maxOutputTokens: COMMIT_SUBJECT_MAX_OUTPUT_TOKENS,
    });

    expect(text).toBe("Add a panel to the home screen");
    expect(completeSimpleCalls).toHaveLength(1);
    const call = completeSimpleCalls[0]!;
    // The light tier, not the calling agent's model.
    expect((call.model as { id: string }).id).toBe("deepseek-v4-flash");
    // Exactly one message, no system prompt, no tools, no history.
    const context = call.context as {
      messages: unknown[];
      systemPrompt?: string;
      tools?: unknown[];
    };
    expect(context.messages).toHaveLength(1);
    expect(context.systemPrompt).toBeUndefined();
    expect(context.tools).toBeUndefined();
    expect(call.options).toMatchObject({
      apiKey: "key-123",
      maxTokens: COMMIT_SUBJECT_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
  });

  it("throws when the provider reports an error stop reason", async () => {
    completeSimpleResult = {
      stopReason: "error",
      errorMessage: "upstream 500",
      content: [],
    };

    await expect(
      runLightTextCompletion({
        route: nativeRoute as never,
        userPrompt: "x",
        agentType: "general",
        stellaAppDir: "/tmp/app",
        stellaDataDir: "/tmp/data",
      }),
    ).rejects.toThrow("upstream 500");
  });

  it("routes through the Claude Code CLI on that engine's light model", async () => {
    const text = await runLightTextCompletion({
      route: {
        activeEngine: "claude_code_local",
        executionEngine: "claude-code",
        modelId: "claude-code/haiku",
        claudeCodeModel: "haiku",
      } as never,
      userPrompt: "x",
      agentType: "general",
      stellaAppDir: "/tmp/app",
      stellaDataDir: "/tmp/data",
    });

    expect(text).toBe("Rename the sidebar toggle");
    expect(completeSimpleCalls).toHaveLength(0);
    expect(claudeCodeCalls).toHaveLength(1);
    expect(claudeCodeCalls[0]).toMatchObject({
      modelOverride: "haiku",
      effortLevel: "low",
      // Preferences come from the data dir; the CLI runs in the app dir.
      stellaAppDir: "/tmp/data",
      cwd: "/tmp/app",
    });
  });
});
