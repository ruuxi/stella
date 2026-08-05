import { describe, expect, it, vi } from "vitest";

import type { Agent } from "../../../../../runtime/kernel/agent-core/agent.js";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import type { LocalAgentContext } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { PiSessionCore } from "../../../../../runtime/kernel/agent-runtime/pi-session-core.js";
import {
  QUARANTINE_CUSTOM_TYPE,
  QUARANTINE_PLACEHOLDER,
  SAFETY_SWAP_STELLA_MODEL_ID,
  serializeQuarantineRecord,
} from "../../../../../runtime/kernel/agent-runtime/provider-abort-containment.js";
import { executeRuntimeAgentPrompt } from "../../../../../runtime/kernel/agent-runtime/run-execution.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentTurnWithRetry,
  type AgentRunFailure,
  type AgentRunRetryState,
} from "../../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";
import { providerAbortedStopMessage } from "../../../../../runtime/ai/utils/provider-stop.js";
import type {
  Api,
  Model,
  StopReason,
} from "../../../../../runtime/ai/types.js";

const SAFETY_ABORT_MESSAGE = providerAbortedStopMessage("refusal");

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (
  timestamp: number,
  text = "do the thing",
): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

const assistantMessage = (
  timestamp: number,
  stopReason: StopReason,
  args?: { errorMessage?: string; text?: string },
): AgentMessage => ({
  role: "assistant",
  content: args?.text ? [{ type: "text", text: args.text }] : [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-fable-5",
  usage,
  stopReason,
  ...(args?.errorMessage ? { errorMessage: args.errorMessage } : {}),
  timestamp,
});

const fableStellaRoute = (): ResolvedLlmRoute => {
  const model = {
    id: "stella/max",
    name: "max",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://relay.example/api/llm",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 0,
  } as Model<Api>;
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    "claude-fable-5";
  return {
    route: "stella",
    model,
    getApiKey: () => "token",
  };
};

/** Expose PiSessionCore's protected containment surface for direct testing. */
class TestSession extends PiSessionCore {
  constructor() {
    super({ threadKey: "test-thread", loggerName: "test-session" });
  }

  setRoute(route: ResolvedLlmRoute): void {
    this.setResolvedLlm(route);
  }

  begin(agent: Agent, agentContext: LocalAgentContext) {
    return this.beginAbortContainmentTurn(agent, agentContext, {});
  }

  swap(agent: Agent, errorMessage: string) {
    return this.prepareSafetyModelSwap(agent, { errorMessage, logContext: {} });
  }

  retrySameModel(agent: Agent, errorMessage: string) {
    return this.prepareSafetySameModelRetry(agent, {
      errorMessage,
      logContext: {},
    });
  }

  retryRun(agent: Agent, failure: AgentRunFailure) {
    return this.prepareAgentRunRetry(agent, {
      failure,
      logContext: {},
    });
  }

  fail(
    agent: Agent,
    args: { messagesBefore: number; errorMessage: string },
  ): string {
    return this.noteAbortContainmentFailure(agent, {
      ...args,
      logContext: {},
    });
  }

  streak(): number {
    return this.abortContainment.consecutiveInstantAbortCount;
  }
}

const fakeAgent = (messages: AgentMessage[], route: ResolvedLlmRoute) =>
  ({
    state: { messages, model: route.model },
    subscribe: () => () => {},
    prompt: vi.fn(async () => {}),
    followUp: vi.fn(),
    continue: vi.fn(async () => {}),
    abort: vi.fn(),
  }) as unknown as Agent & {
    prompt: ReturnType<typeof vi.fn>;
    continue: ReturnType<typeof vi.fn>;
  };

describe("prepareSafetyModelSwap bail path", () => {
  it("does not mutate the context when it bails on an assistant tail", () => {
    // Shape: popping the errored assistant would leave another assistant at
    // the tail (mid-loop failure). The swap must bail WITHOUT popping —
    // a mutating bail would corrupt the appended slice that failure
    // classification reads and silently reset the containment streak.
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "stop", { text: "earlier reply" }),
      assistantMessage(3, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const swap = session.swap(agent, SAFETY_ABORT_MESSAGE);

    expect(swap).toBeNull();
    expect(messages).toHaveLength(3);
    expect(agent.state.model.id).toBe("stella/max");

    // Failure classification still sees the errored assistant → the
    // deterministic-abort streak advances instead of resetting.
    const surfaced = session.fail(agent, {
      messagesBefore: 2,
      errorMessage: SAFETY_ABORT_MESSAGE,
    });
    expect(surfaced).toBe(SAFETY_ABORT_MESSAGE);
    expect(session.streak()).toBe(1);
  });

  it("pops the errored tail only when the swap is committed", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const swap = session.swap(agent, SAFETY_ABORT_MESSAGE);

    expect(swap).not.toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(agent.state.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
  });
});

describe("prepareSafetySameModelRetry", () => {
  it("pops the errored tail and keeps the fable route for a same-model retry", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const retry = session.retrySameModel(agent, SAFETY_ABORT_MESSAGE);

    expect(retry).toEqual({ modelId: "stella/max" });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    // The route is untouched — the retry runs on the configured model.
    expect(agent.state.model.id).toBe("stella/max");
  });

  it("declines non-safety errors and non-fable routes", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const agent = fakeAgent(
      [
        userMessage(1),
        assistantMessage(2, "error", { errorMessage: "boring timeout" }),
      ],
      route,
    );
    expect(session.retrySameModel(agent, "boring timeout")).toBeNull();

    // Same safety error, but the route already swapped to opus: no retry —
    // failures on the fallback surface normally.
    const swapped = session.swap(agent, SAFETY_ABORT_MESSAGE);
    expect(swapped).not.toBeNull();
    expect(session.retrySameModel(agent, SAFETY_ABORT_MESSAGE)).toBeNull();
  });

  it("bails without mutating on an unexpected assistant tail", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "stop", { text: "earlier reply" }),
      assistantMessage(3, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    expect(session.retrySameModel(agent, SAFETY_ABORT_MESSAGE)).toBeNull();
    expect(messages).toHaveLength(3);
  });
});

describe("swap-resume flow (end to end)", () => {
  it("retries a transient failure during the safety-model swap stage", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    // Attempt 1: the provider aborts on the first model call.
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(
        assistantMessage(100, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
      );
    });
    // Attempt 2 (after swap): transport fails transiently. The shared run
    // envelope resumes the swapped model again and attempt 3 succeeds.
    agent.continue
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(200, "error", { errorMessage: "500 Server Error" }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(assistantMessage(300, "stop", { text: "recovered" }));
      });

    const executionArgs = {
      agent,
      promptMessages: [{ text: "summarize the emails" }],
      runId: "run-1",
      agentType: "general",
      userMessageId: "msg-1",
      recorder: {} as never,
    };

    const retryState: AgentRunRetryState = {
      attemptsUsed: 0,
      retriesUsed: 0,
    };
    const executeWithRetry = (initialResume = false) =>
      executeAgentTurnWithRetry({
        state: retryState,
        initialResume,
        execute: (resume) =>
          executeRuntimeAgentPrompt({
            ...executionArgs,
            ...(resume ? { resume: true } : {}),
          }),
        prepareRetry: (failure) => session.retryRun(agent, failure),
        random: () => 0.5,
        sleep: async () => undefined,
      });

    const attempt1 = await executeWithRetry();
    expect(attempt1.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    const swap = session.swap(agent, attempt1.errorMessage!);
    expect(swap).not.toBeNull();
    expect(swap!.fromModelId).toBe("stella/max");
    expect(swap!.toModelId).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(agent.state.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    // The errored assistant was dropped; the prompt is still in context.
    expect(messages.at(-1)?.role).toBe("user");

    const attempt2 = await executeWithRetry(true);
    expect(attempt2.errorMessage).toBeUndefined();
    expect(attempt2.finalText).toBe("recovered");
    // Resume mode: no second prompt append; both post-swap provider calls
    // continue from the retained prompt state.
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.continue).toHaveBeenCalledTimes(2);
    expect(retryState).toEqual({ attemptsUsed: 3, retriesUsed: 1 });
  });
});

describe("transient run retry resume flow", () => {
  it("retries a transient failure raised by a resumed safety-stage call", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(
        assistantMessage(100, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
      );
    });
    agent.continue
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(200, "error", { errorMessage: "500 Server Error" }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(assistantMessage(300, "stop", { text: "recovered" }));
      });

    const retryState: AgentRunRetryState = {
      attemptsUsed: 0,
      retriesUsed: 0,
    };
    const executionArgs = {
      agent,
      promptMessages: [{ text: "summarize safely" }],
      runId: "run-safety-transient",
      agentType: "general",
      userMessageId: "msg-safety-transient",
      recorder: {} as never,
    };
    const executeWithRetry = (initialResume = false) =>
      executeAgentTurnWithRetry({
        state: retryState,
        initialResume,
        execute: (resume) =>
          executeRuntimeAgentPrompt({
            ...executionArgs,
            ...(resume ? { resume: true } : {}),
          }),
        prepareRetry: (failure) => session.retryRun(agent, failure),
        random: () => 0.5,
        sleep: async () => undefined,
      });

    let execution = await executeWithRetry();
    expect(execution.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(
      session.retrySameModel(agent, execution.errorMessage!),
    ).not.toBeNull();

    execution = await executeWithRetry(true);

    expect(execution).toMatchObject({ finalText: "recovered", attempts: 3 });
    expect(retryState).toEqual({ attemptsUsed: 3, retriesUsed: 1 });
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledTimes(2);
  });

  it("shares the four-provider-attempt budget across safety stages", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(
        assistantMessage(100, "error", { errorMessage: "500 Server Error" }),
      );
    });
    agent.continue
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(200, "error", { errorMessage: "500 Server Error" }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(300, "error", {
            errorMessage: SAFETY_ABORT_MESSAGE,
          }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(400, "error", {
            errorMessage: "429 provider rate limit exceeded",
          }),
        );
      });

    const retryState: AgentRunRetryState = {
      attemptsUsed: 0,
      retriesUsed: 0,
    };
    const executionArgs = {
      agent,
      promptMessages: [{ text: "stay within the turn budget" }],
      runId: "run-shared-budget",
      agentType: "general",
      userMessageId: "msg-shared-budget",
      recorder: {} as never,
    };
    const executeWithRetry = (initialResume = false) =>
      executeAgentTurnWithRetry({
        state: retryState,
        initialResume,
        execute: (resume) =>
          executeRuntimeAgentPrompt({
            ...executionArgs,
            ...(resume ? { resume: true } : {}),
          }),
        prepareRetry: (failure) => session.retryRun(agent, failure),
        random: () => 0.5,
        sleep: async () => undefined,
      });

    let execution = await executeWithRetry();
    expect(execution.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(
      session.retrySameModel(agent, execution.errorMessage!),
    ).not.toBeNull();

    execution = await executeWithRetry(true);

    expect(retryState.attemptsUsed).toBe(AGENT_RUN_MAX_ATTEMPTS);
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledTimes(3);
    expect(execution.attempts).toBe(AGENT_RUN_MAX_ATTEMPTS);
    expect(execution.errorMessage).toContain(
      "Automatic recovery exhausted after 4 attempts (rate_limit)",
    );
  });

  it("resumes after completed tool results without replaying the side effect", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    const sideEffect = vi.fn();
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      sideEffect();
      messages.push({
        role: "toolResult",
        toolCallId: "call-write",
        toolName: "apply_patch",
        content: [{ type: "text", text: "write completed" }],
        isError: false,
        timestamp: 50,
      });
      messages.push(
        assistantMessage(100, "error", {
          errorMessage: "unexpected EOF",
        }),
      );
    });
    agent.continue.mockImplementation(async () => {
      expect(messages.at(-1)?.role).toBe("toolResult");
      messages.push(assistantMessage(200, "stop", { text: "recovered" }));
    });

    const result = await executeAgentTurnWithRetry({
      execute: (resume) =>
        executeRuntimeAgentPrompt({
          agent,
          promptMessages: [{ text: "make one durable change" }],
          runId: "run-transient-tool",
          agentType: "general",
          userMessageId: "msg-transient-tool",
          recorder: {} as never,
          ...(resume ? { resume: true } : {}),
        }),
      prepareRetry: (failure) => session.retryRun(agent, failure),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ finalText: "recovered", attempts: 2 });
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledOnce();
  });

  it("retries a clean empty assistant tail instead of finalizing fake success", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(assistantMessage(100, "stop"));
    });
    agent.continue.mockImplementation(async () => {
      expect(messages.at(-1)?.role).toBe("user");
      messages.push(assistantMessage(200, "stop", { text: "real result" }));
    });

    const result = await executeAgentTurnWithRetry({
      execute: (resume) =>
        executeRuntimeAgentPrompt({
          agent,
          promptMessages: [{ text: "return a result" }],
          runId: "run-empty-retry",
          agentType: "general",
          userMessageId: "msg-empty-retry",
          recorder: {} as never,
          ...(resume ? { resume: true } : {}),
        }),
      prepareRetry: (failure) => session.retryRun(agent, failure),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ finalText: "real result", attempts: 2 });
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledOnce();
  });
});

describe("quarantine restart re-seeding through the session", () => {
  it("re-masks persisted quarantine records on a fresh session", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const record = { key: "20:call-a", toolName: "read_email", timestamp: 20 };
    const agentContext = {
      threadHistory: [
        {
          role: "runtimeInternal",
          content: "",
          customMessage: {
            customType: QUARANTINE_CUSTOM_TYPE,
            content: [
              {
                type: "text" as const,
                text: serializeQuarantineRecord(record),
              },
            ],
            display: false,
          },
        },
      ],
    } as unknown as LocalAgentContext;

    const messages: AgentMessage[] = [
      userMessage(10),
      {
        role: "toolResult",
        toolCallId: "call-a",
        toolName: "read_email",
        content: [{ type: "text", text: "poisoned quoted content" }],
        isError: false,
        timestamp: 20,
      },
    ];
    const agent = fakeAgent(messages, route);

    const turn = session.begin(agent, agentContext);

    expect(turn.messagesBefore).toBe(2);
    expect(turn.newlyQuarantined).toBeNull();
    const masked = messages[1];
    if (masked.role === "toolResult") {
      expect((masked.content[0] as { text: string }).text).toContain(
        QUARANTINE_PLACEHOLDER,
      );
    }
  });
});
