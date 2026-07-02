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
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";
import { providerAbortedStopMessage } from "../../../../../runtime/ai/utils/provider-stop.js";
import type { Api, Model, StopReason } from "../../../../../runtime/ai/types.js";

const SAFETY_ABORT_MESSAGE = providerAbortedStopMessage("refusal");

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (timestamp: number, text = "do the thing"): AgentMessage => ({
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

describe("swap-resume flow (end to end)", () => {
  it("fable safety abort → swap to opus → resume continues without re-prompting", async () => {
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
    // Attempt 2 (after swap): the loop resumes cleanly on the new model.
    agent.continue.mockImplementation(async () => {
      messages.push(assistantMessage(200, "stop", { text: "recovered" }));
    });

    const executionArgs = {
      agent,
      promptMessages: [{ text: "summarize the emails" }],
      runId: "run-1",
      agentType: "general",
      userMessageId: "msg-1",
      recorder: {} as never,
    };

    const attempt1 = await executeRuntimeAgentPrompt(executionArgs);
    expect(attempt1.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    const swap = session.swap(agent, attempt1.errorMessage!);
    expect(swap).not.toBeNull();
    expect(swap!.fromModelId).toBe("stella/max");
    expect(swap!.toModelId).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(agent.state.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    // The errored assistant was dropped; the prompt is still in context.
    expect(messages.at(-1)?.role).toBe("user");

    const attempt2 = await executeRuntimeAgentPrompt({
      ...executionArgs,
      resume: true,
    });
    expect(attempt2.errorMessage).toBeUndefined();
    expect(attempt2.finalText).toBe("recovered");
    // Resume mode: no second prompt append, exactly one continue.
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.continue).toHaveBeenCalledTimes(1);
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
              { type: "text" as const, text: serializeQuarantineRecord(record) },
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
