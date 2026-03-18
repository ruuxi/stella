import { beforeEach, describe, expect, it, vi } from "vitest";

const { canResolveRunnerLlmRouteMock } = vi.hoisted(() => ({
  canResolveRunnerLlmRouteMock: vi.fn(),
}));

vi.mock("../../../electron/core/runtime/runner/model-selection.js", () => ({
  canResolveRunnerLlmRoute: canResolveRunnerLlmRouteMock,
}));

const {
  getOrchestratorHealth,
  normalizeAutomationRunInput,
  normalizeChatRunInput,
} = await import("../../../electron/core/runtime/runner/orchestrator-policy.js");

describe("runner orchestrator policy", () => {
  beforeEach(() => {
    canResolveRunnerLlmRouteMock.mockReset();
  });

  it("reports missing auth token when direct resolution is unavailable", () => {
    canResolveRunnerLlmRouteMock.mockReturnValue(false);

    const health = getOrchestratorHealth(
      {
        state: {
          isRunning: true,
          isInitialized: true,
          proxyBaseUrl: "https://demo.convex.site/api/stella/v1",
          authToken: null,
        },
      } as never,
      {
        resolveAgent: vi.fn(),
        getConfiguredModel: vi.fn(() => "openai/gpt-4.1-mini"),
      },
    );

    expect(health).toEqual({
      ready: false,
      reason: "Missing auth token",
      engine: "pi",
    });
  });

  it("normalizes chat and automation inputs consistently", () => {
    expect(
      normalizeChatRunInput({
        conversationId: "conv-1",
        userMessageId: "user-1",
        userPrompt: "  hello  ",
      }),
    ).toEqual({
      conversationId: "conv-1",
      userPrompt: "hello",
      agentType: "orchestrator",
    });

    expect(
      normalizeAutomationRunInput({
        conversationId: "  conv-2  ",
        userPrompt: "  automate  ",
        agentType: "general",
      }),
    ).toEqual({
      conversationId: "conv-2",
      userPrompt: "automate",
      agentType: "general",
    });
  });
});
