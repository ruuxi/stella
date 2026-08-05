import { describe, expect, it } from "vitest";
import { MODELS } from "../../../../../runtime/ai/models.generated.js";
import {
  registerModel,
  unregisterModel,
} from "../../../../../runtime/ai/models.js";
import type { Model } from "../../../../../runtime/ai/types.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  createStateContext,
  handleSendInput,
  handleSpawnAgent,
  parseSpawnAgentModel,
} from "../../../../../runtime/kernel/tools/state.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { AgentToolRequest } from "../../../../../runtime/kernel/tools/types.js";

const COLON_BEARING_REGISTRY_REFERENCES = Object.entries(MODELS).flatMap(
  ([registryProvider, models]) =>
    Object.values(models as Record<string, { id: string }>)
      .filter((model) => model.id.includes(":"))
      .map((model) => `${registryProvider}/${model.id}`),
);

describe("state tools", () => {
  it("defaults spawn_agent to the general agent", async () => {
    const now = Date.now();
    let createdRequest: AgentToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createAgent: async (request) => {
        createdRequest = request;
        return {
          threadId: "thread-1",
          activeThreads: [
            {
              threadId: "thread-1",
              name: "thread-1",
              conversationId: "conversation-1",
              agentType: AGENT_IDS.GENERAL,
              status: "active",
              createdAt: 1,
              lastUsedAt: now,
              description: "Do work",
            },
            {
              threadId: "thread-0",
              name: "thread-0",
              conversationId: "conversation-1",
              agentType: AGENT_IDS.GENERAL,
              status: "active",
              createdAt: 1,
              lastUsedAt: now,
              description: "Previous task",
              agentStatus: "running",
            },
          ],
        };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    const result = await handleSpawnAgent(
      ctx,
      {
        description: "Do work",
        prompt: "Do the work",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(createdRequest?.agentType).toBe(AGENT_IDS.GENERAL);
    expect(result).toEqual({
      result: {
        thread_id: "thread-1",
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        note: "Task has started but is NOT finished yet. Wait for the completion event before telling the user it is done.",
        other_threads: [
          {
            thread_id: "thread-0",
            status: "active",
            last_active: "just now",
            description: "Previous task",
          },
        ],
      },
    });
  });

  const createSpawnContext = (
    validateSpawnModel?: (modelName: string) => void,
    validateSpawnModelWithMetadata?: Parameters<typeof createStateContext>[3],
  ) => {
    const created: AgentToolRequest[] = [];
    const ctx = createStateContext(
      "/tmp",
      {
        createAgent: async (request) => {
          created.push(request);
          return { threadId: "thread-1" };
        },
        getAgent: async () => null,
        cancelAgent: async () => ({ canceled: false }),
      },
      validateSpawnModel,
      validateSpawnModelWithMetadata,
    );
    return { ctx, created };
  };

  const orchestratorToolContext = {
    conversationId: "conversation-1",
    deviceId: "device-1",
    requestId: "request-1",
    agentType: AGENT_IDS.ORCHESTRATOR,
    modelConfigSnapshot: {
      engine: "default" as const,
      routeModel: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "high" as const,
    },
  };

  it("treats `model: default` exactly like an omitted model", async () => {
    const validated: string[] = [];
    const { ctx, created } = createSpawnContext((modelName) => {
      validated.push(modelName);
    });

    const result = await handleSpawnAgent(
      ctx,
      { description: "Do work", prompt: "Do the work.", model: "default" },
      orchestratorToolContext,
    );

    expect(result).toMatchObject({ result: { thread_id: "thread-1" } });
    expect(validated).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]?.agentType).toBe(AGENT_IDS.GENERAL);
    expect(created[0]?.model).toBeUndefined();
    expect(created[0]?.spawnEngine).toBeUndefined();
  });

  it("captures the configured General snapshot for an unqualified Orchestrator spawn", async () => {
    const created: AgentToolRequest[] = [];
    const generalSnapshot = {
      engine: "default" as const,
      routeModel:
        "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
      reasoningEffort: "xhigh" as const,
    };
    const captured: Array<Record<string, unknown>> = [];
    const ctx = createStateContext(
      "/tmp",
      {
        createAgent: async (request) => {
          created.push(request);
          return { threadId: "thread-1" };
        },
        getAgent: async () => null,
        cancelAgent: async () => ({ canceled: false }),
      },
      undefined,
      undefined,
      async (args) => {
        captured.push(args);
        return generalSnapshot;
      },
    );

    await handleSpawnAgent(
      ctx,
      { description: "Do work", prompt: "Do the work." },
      orchestratorToolContext,
    );

    expect(captured).toEqual([
      { agentType: AGENT_IDS.GENERAL, spawnEngine: { engine: "default" } },
    ]);
    expect(created[0]?.modelConfigSnapshot).toEqual(generalSnapshot);
    expect(created[0]?.modelConfigSnapshot).not.toEqual(
      orchestratorToolContext.modelConfigSnapshot,
    );
  });

  it("keeps every no-suffix parse result byte-for-byte compatible", () => {
    expect(parseSpawnAgentModel(undefined)).toEqual({ kind: "default" });
    expect(parseSpawnAgentModel("default")).toEqual({ kind: "default" });
    expect(parseSpawnAgentModel("stella")).toEqual({
      kind: "engine",
      engine: { engine: "default" },
    });
    expect(parseSpawnAgentModel("stella/gpt-5.6-sol")).toEqual({
      kind: "model",
      model: "stella/gpt-5.6-sol",
    });
    expect(parseSpawnAgentModel("codex/gpt-5.6-luna")).toEqual({
      kind: "engine",
      engine: { engine: "codex_cli", model: "gpt-5.6-luna" },
    });
    expect(parseSpawnAgentModel("claude-code/claude-sonnet-5")).toEqual({
      kind: "engine",
      engine: {
        engine: "claude_code_local",
        model: "claude-sonnet-5",
      },
    });
  });

  it.each(COLON_BEARING_REGISTRY_REFERENCES)(
    "preserves registered colon-bearing model reference %s",
    (modelReference) => {
      expect(parseSpawnAgentModel(modelReference)).toEqual({
        kind: "model",
        model: modelReference,
      });
    },
  );

  it("lets a registered model ending in an effort word win over suffix parsing", () => {
    const modelReference = "spawn-test/future-model:high";
    registerModel("spawn-test", {
      id: "future-model:high",
      name: "Future Model",
      api: "openai-completions",
      provider: "spawn-test",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    } as Model<any>);
    try {
      expect(parseSpawnAgentModel(modelReference)).toEqual({
        kind: "model",
        model: modelReference,
      });
    } finally {
      unregisterModel("spawn-test", "future-model:high");
    }
  });

  it("preserves colon-bearing open-ended gateway references verbatim", async () => {
    const references = [
      "stella/openrouter/arcee-ai/trinity-large-preview:free",
      "openrouter/vendor/future-model:free",
      "stella/openrouter/x:high",
    ];
    for (const modelReference of references) {
      expect(parseSpawnAgentModel(modelReference)).toEqual({
        kind: "model",
        model: modelReference,
      });
    }

    const validated: string[] = [];
    const { ctx, created } = createSpawnContext((modelName) => {
      validated.push(modelName);
    });
    for (const model of references) {
      await handleSpawnAgent(
        ctx,
        { description: "Gateway task", prompt: "Do it.", model },
        orchestratorToolContext,
      );
    }
    expect(validated).toEqual(references);
    expect(created).toHaveLength(references.length);
    for (const [index, model] of references.entries()) {
      expect(created[index]).toMatchObject({
        model,
        spawnEngine: { engine: "default" },
      });
      expect(created[index]?.spawnReasoningEffort).toBeUndefined();
    }
  });

  it("parses effort suffixes after all model and engine forms", () => {
    const knownModel = (candidate: string) => candidate === "stella/grok-4.5";
    expect(parseSpawnAgentModel("stella/grok-4.5:medium", knownModel)).toEqual({
      kind: "model",
      model: "stella/grok-4.5",
      reasoningEffort: "medium",
    });
    expect(parseSpawnAgentModel("codex/gpt-5.6-sol:xhigh")).toEqual({
      kind: "engine",
      engine: { engine: "codex_cli", model: "gpt-5.6-sol" },
      reasoningEffort: "xhigh",
    });
    expect(parseSpawnAgentModel("claude-code/claude-fable-5:high")).toEqual({
      kind: "engine",
      engine: {
        engine: "claude_code_local",
        model: "claude-fable-5",
      },
      reasoningEffort: "high",
    });
    expect(parseSpawnAgentModel("default:high")).toEqual({
      kind: "default",
      reasoningEffort: "high",
    });
    expect(parseSpawnAgentModel("stella:high")).toEqual({
      kind: "engine",
      engine: { engine: "default" },
      reasoningEffort: "high",
    });
    expect(parseSpawnAgentModel("codex:xhigh")).toEqual({
      kind: "engine",
      engine: { engine: "codex_cli" },
      reasoningEffort: "xhigh",
    });
  });

  it("rejects unknown or empty effort suffixes before creating a task", async () => {
    const { ctx, created } = createSpawnContext((modelName) => {
      if (modelName === "stella/grok-4.5") return;
      throw new Error(`Unknown model: ${modelName}`);
    });
    for (const model of ["stella/grok-4.5:max", "codex:"]) {
      const result = await handleSpawnAgent(
        ctx,
        { description: "Do work", prompt: "Do it.", model },
        orchestratorToolContext,
      );
      expect(result).toEqual({
        error: expect.stringContaining(
          "Expected one of :low, :medium, :high, or :xhigh",
        ),
      });
    }
    expect(created).toHaveLength(0);
  });

  it("keeps effort scoped to only the spawn that requested it", async () => {
    const { ctx, created } = createSpawnContext((modelName) => {
      if (modelName === "stella/grok-4.5") return;
      throw new Error(`Unknown model: ${modelName}`);
    });
    await handleSpawnAgent(
      ctx,
      {
        description: "Reasoning task",
        prompt: "Do it.",
        model: "stella/grok-4.5:high",
      },
      orchestratorToolContext,
    );
    await handleSpawnAgent(
      ctx,
      {
        description: "Normal task",
        prompt: "Do it.",
        model: "stella/grok-4.5",
      },
      orchestratorToolContext,
    );
    expect(created[0]?.spawnReasoningEffort).toBe("high");
    expect(created[1]?.spawnReasoningEffort).toBeUndefined();
  });

  it("passes the effort suffix to catalog-aware final validation", async () => {
    const validated: Array<[string, string | undefined]> = [];
    const { ctx, created } = createSpawnContext(
      () => {},
      async (modelName, reasoningEffort) => {
        validated.push([modelName, reasoningEffort]);
        throw new Error(
          'Selected model is served by Codex; use "codex/gpt-5.6-sol:high" instead.',
        );
      },
    );

    const result = await handleSpawnAgent(
      ctx,
      {
        description: "Sol task",
        prompt: "Do it.",
        model: "stella/gpt-5.6-sol:high",
      },
      orchestratorToolContext,
    );

    expect(validated).toEqual([["stella/gpt-5.6-sol", "high"]]);
    expect(result.error).toContain('"codex/gpt-5.6-sol:high"');
    expect(created).toHaveLength(0);
  });

  it("forwards a plain model override through validation", async () => {
    const validated: string[] = [];
    const { ctx, created } = createSpawnContext((modelName) => {
      validated.push(modelName);
    });

    const result = await handleSpawnAgent(
      ctx,
      {
        description: "Bulk file processing",
        prompt: "Process the files.",
        model: "openrouter/moonshotai/kimi-k2.5",
      },
      orchestratorToolContext,
    );

    expect(result).toMatchObject({ result: { thread_id: "thread-1" } });
    expect(validated).toEqual(["openrouter/moonshotai/kimi-k2.5"]);
    expect(created[0]?.model).toBe("openrouter/moonshotai/kimi-k2.5");
    expect(created[0]?.spawnEngine).toEqual({ engine: "default" });
  });

  it("forces the Stella engine for an explicit Stella model pin", async () => {
    const { ctx, created } = createSpawnContext(() => {});

    await handleSpawnAgent(
      ctx,
      {
        description: "Sol task",
        prompt: "Do it.",
        model: "stella/gpt-5.6-sol",
      },
      orchestratorToolContext,
    );

    expect(created[0]?.model).toBe("stella/gpt-5.6-sol");
    expect(created[0]?.spawnEngine).toEqual({ engine: "default" });
  });

  it("fails a plain model override when no validator is wired instead of dying mid-run", async () => {
    const { ctx, created } = createSpawnContext();

    const result = await handleSpawnAgent(
      ctx,
      { description: "Cheap task", prompt: "Do it.", model: "stella/light" },
      orchestratorToolContext,
    );

    expect(result).toEqual({
      error:
        'Cannot honor model "stella/light": model routing is not available in this runtime. Omit the model parameter to use the configured default.',
    });
    expect(created).toHaveLength(0);
  });

  it("matches engine ids case-insensitively", async () => {
    const { ctx, created } = createSpawnContext();

    await handleSpawnAgent(
      ctx,
      {
        description: "Repo work",
        prompt: "Fix the bug.",
        model: "Codex/gpt-5.4-codex",
      },
      orchestratorToolContext,
    );
    await handleSpawnAgent(
      ctx,
      { description: "CC task", prompt: "Do it.", model: "Claude-Code" },
      orchestratorToolContext,
    );

    expect(created[0]?.spawnEngine).toEqual({
      engine: "codex_cli",
      model: "gpt-5.4-codex",
    });
    expect(created[1]?.spawnEngine).toEqual({ engine: "claude_code_local" });
  });

  it("rejects the removed agent_type argument loudly", async () => {
    const { ctx, created } = createSpawnContext();

    const result = await handleSpawnAgent(
      ctx,
      {
        description: "Research task",
        prompt: "Research it.",
        agent_type: "research",
      },
      orchestratorToolContext,
    );

    expect(result).toEqual({
      error:
        "agent_type has been removed from spawn_agent. Every spawn runs the general agent; use the optional `model` parameter to pick a model or engine instead.",
    });
    expect(created).toHaveLength(0);
  });

  it("selects an engine from a bare engine id without validating a route", async () => {
    const validated: string[] = [];
    const { ctx, created } = createSpawnContext((modelName) => {
      validated.push(modelName);
    });

    await handleSpawnAgent(
      ctx,
      { description: "Stella work", prompt: "Fix the bug.", model: "stella" },
      orchestratorToolContext,
    );
    await handleSpawnAgent(
      ctx,
      { description: "Repo work", prompt: "Fix the bug.", model: "codex" },
      orchestratorToolContext,
    );

    expect(validated).toEqual([]);
    expect(created[0]?.model).toBeUndefined();
    expect(created[0]?.spawnEngine).toEqual({ engine: "default" });
    expect(created[1]?.model).toBeUndefined();
    expect(created[1]?.spawnEngine).toEqual({ engine: "codex_cli" });
  });

  it("pins an engine-native model via engine/<model>", async () => {
    const { ctx, created } = createSpawnContext();

    await handleSpawnAgent(
      ctx,
      {
        description: "Repo work",
        prompt: "Fix the bug.",
        model: "codex/gpt-5.4-codex",
      },
      orchestratorToolContext,
    );

    expect(created[0]?.spawnEngine).toEqual({
      engine: "codex_cli",
      model: "gpt-5.4-codex",
    });
  });

  it("selects claude-code per-spawn, with and without a pinned model", async () => {
    const { ctx, created } = createSpawnContext();

    await handleSpawnAgent(
      ctx,
      { description: "CC task", prompt: "Do it.", model: "claude-code" },
      orchestratorToolContext,
    );
    await handleSpawnAgent(
      ctx,
      { description: "CC task", prompt: "Do it.", model: "claude-code/opus" },
      orchestratorToolContext,
    );

    expect(created[0]?.spawnEngine).toEqual({ engine: "claude_code_local" });
    expect(created[1]?.spawnEngine).toEqual({
      engine: "claude_code_local",
      model: "opus",
    });
  });

  it("fails the spawn loudly when the model cannot be routed", async () => {
    const routeError =
      'No provider route for model "banana/split". Connect the provider or pick a different model.';
    const { ctx, created } = createSpawnContext(() => {
      throw new Error(routeError);
    });

    const result = await handleSpawnAgent(
      ctx,
      { description: "Do work", prompt: "Do it.", model: "banana/split" },
      orchestratorToolContext,
    );

    expect(result).toEqual({ error: routeError });
    expect(created).toHaveLength(0);
  });

  it("lets a General parent spawn a subagent and blocks the next level down", async () => {
    const { ctx, created } = createSpawnContext();
    const parentContext = {
      conversationId: "conversation-1",
      deviceId: "device-1",
      requestId: "request-parent",
      agentType: AGENT_IDS.GENERAL,
      agentId: "parent-1",
      agentDepth: 1,
      maxAgentDepth: 2,
    } as const;

    await expect(
      handleSpawnAgent(
        ctx,
        { description: "Fresh review", prompt: "Review the current work." },
        parentContext,
      ),
    ).resolves.toMatchObject({ result: { thread_id: "thread-1" } });
    expect(created[0]).toMatchObject({
      agentType: AGENT_IDS.GENERAL,
      parentAgentId: "parent-1",
      agentDepth: 2,
      maxAgentDepth: 2,
    });

    // Depth 2 is the effective cap, so the subagent itself cannot spawn.
    await expect(
      handleSpawnAgent(
        ctx,
        { description: "Too deep", prompt: "Should not run." },
        { ...parentContext, agentId: "thread-1", agentDepth: 2 },
      ),
    ).resolves.toEqual({
      error:
        "Task depth limit reached (2). Complete work in the current task instead of creating another subtask.",
    });
    expect(created).toHaveLength(1);
  });

  it("rejects task creation from agents that are neither orchestrator nor General", async () => {
    const { ctx, created } = createSpawnContext();

    const result = await handleSpawnAgent(
      ctx,
      {
        description: "Do work",
        prompt: "Run it",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.EXPLORE,
        agentId: "explore-1",
      },
    );

    expect(result).toEqual({
      error: "Only the orchestrator or a General agent can create tasks.",
    });
    expect(created).toHaveLength(0);
  });

  it("allows parent-owned General subagents on every external engine", async () => {
    const { ctx, created } = createSpawnContext();
    const parentContext = {
      conversationId: "conversation-1",
      deviceId: "device-1",
      requestId: "request-parent",
      agentType: AGENT_IDS.GENERAL,
      agentId: "parent-1",
      agentDepth: 1,
      maxAgentDepth: 2,
    } as const;

    await handleSpawnAgent(
      ctx,
      { description: "Codex task", prompt: "Do it.", model: "codex" },
      parentContext,
    );
    await handleSpawnAgent(
      ctx,
      {
        description: "Claude Code task",
        prompt: "Do it.",
        model: "claude-code/opus",
      },
      parentContext,
    );

    expect(created).toMatchObject([
      {
        agentType: AGENT_IDS.GENERAL,
        parentAgentId: "parent-1",
        spawnEngine: { engine: "codex_cli" },
      },
      {
        agentType: AGENT_IDS.GENERAL,
        parentAgentId: "parent-1",
        spawnEngine: { engine: "claude_code_local", model: "opus" },
      },
    ]);
  });

  it("rejects the removed spawn_agent group argument", async () => {
    const { ctx, created } = createSpawnContext();
    await expect(
      handleSpawnAgent(
        ctx,
        {
          description: "Grouped task",
          prompt: "Do it.",
          group: "old group",
        },
        orchestratorToolContext,
      ),
    ).resolves.toEqual({
      error:
        "group has been removed from spawn_agent. Spawn a General agent and let it run its own subagents to coordinate related multi-agent work.",
    });
    expect(created).toHaveLength(0);
  });

  it("replaces generic descriptions with prompt context", async () => {
    let createdRequest: AgentToolRequest | null = null;
    const ctx = createStateContext("/tmp", {
      createAgent: async (request) => {
        createdRequest = request;
        return { threadId: "thread-1" };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    await handleSpawnAgent(
      ctx,
      {
        description: "Task",
        prompt:
          "Inspect the working indicator behavior and fix the stale footer text.",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(createdRequest?.description).toBe(
      "Inspect the working indicator behavior and fix the stale footer text.",
    );
  });

  it("forwards pause_agent to cancelAgent with the pause sentinel reason", async () => {
    const cancelCalls: Array<{ agentId: string; reason: string | undefined }> =
      [];
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async (agentId, reason) => {
        cancelCalls.push({ agentId, reason });
        return { canceled: true };
      },
    });

    const result = await handleSpawnAgent(
      ctx,
      {
        action: "cancel",
        thread_id: "thread-7",
        reason: "user changed their mind",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(cancelCalls).toEqual([
      { agentId: "thread-7", reason: AGENT_PAUSE_CANCEL_REASON },
    ]);
    expect(result).toEqual({
      result: {
        thread_id: "thread-7",
        status: "canceled",
        canceled: true,
      },
    });
  });

  it("passes the current root run through send_input", async () => {
    const sendCalls: Array<{
      threadId: string;
      message: string;
      from: string;
      options:
        | {
            description?: string;
            rootRunId?: string;
            deliveryKind?: "child-report" | "external-input";
          }
        | undefined;
    }> = [];
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
      sendAgentMessage: async (threadId, message, from, options) => {
        sendCalls.push({ threadId, message, from, options });
        return { delivered: true };
      },
    });

    const result = await handleSendInput(
      ctx,
      {
        thread_id: "thread-7",
        message: "continue with the latest requirement",
        description: "Apply latest requirement",
      },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        rootRunId: "root-current",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(result).toEqual({
      result: {
        thread_id: "thread-7",
        status: "updated",
        delivered: true,
      },
    });
    expect(sendCalls).toEqual([
      {
        threadId: "thread-7",
        message: "continue with the latest requirement",
        from: "orchestrator",
        options: {
          deliveryKind: "external-input",
          description: "Apply latest requirement",
          rootRunId: "root-current",
        },
      },
    ]);
  });

  it("never leaks the orchestrator model snapshot on a subagent's send_input", async () => {
    const sendCalls: Array<Record<string, unknown> | undefined> = [];
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "unused" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
      sendAgentMessage: async (_threadId, _message, _from, options) => {
        sendCalls.push(options as Record<string, unknown> | undefined);
        return { delivered: true };
      },
    });

    await expect(
      handleSendInput(
        ctx,
        {
          thread_id: "existing-thread",
          description: "Continue existing build",
          message: "Continue the build.",
        },
        {
          conversationId: "conversation-1",
          deviceId: "device-1",
          requestId: "request-1",
          agentType: AGENT_IDS.GENERAL,
          agentId: "parent-thread",
          modelConfigSnapshot: {
            engine: "default" as const,
            routeModel: "stella/openai/gpt-5.6-sol",
            reasoningEffort: "high" as const,
          },
        },
      ),
    ).resolves.toMatchObject({ result: { delivered: true } });
    expect(sendCalls).toEqual([
      {
        deliveryKind: "external-input",
        description: "Continue existing build",
      },
    ]);
  });

  it("returns thread-not-found when pause_agent targets an unknown thread", async () => {
    const ctx = createStateContext("/tmp", {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    });

    const result = await handleSpawnAgent(
      ctx,
      { action: "cancel", thread_id: "missing-thread" },
      {
        conversationId: "conversation-1",
        deviceId: "device-1",
        requestId: "request-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
      },
    );

    expect(result).toEqual({ error: "Thread not found: missing-thread" });
  });

  it("requires description and prompt for task creation", async () => {
    const ctx = createStateContext("/tmp");

    await expect(
      handleSpawnAgent(
        ctx,
        {
          prompt: "Run it",
        },
        {
          conversationId: "conversation-1",
          deviceId: "device-1",
          requestId: "request-1",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toEqual({
      error: "description is required",
    });

    await expect(
      handleSpawnAgent(
        ctx,
        {
          description: "Do work",
        },
        {
          conversationId: "conversation-1",
          deviceId: "device-1",
          requestId: "request-1",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toEqual({
      error: "prompt is required",
    });
  });
});
