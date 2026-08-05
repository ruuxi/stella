import { beforeEach, describe, expect, it, vi } from "vitest";

const runCompactionWithHooksMock = vi.hoisted(() => vi.fn());

vi.mock(
  "../../../../../runtime/kernel/agent-runtime/run-completion.js",
  () => ({
    runCompactionWithHooks: (...args: unknown[]) =>
      runCompactionWithHooksMock(...args),
  }),
);

// @ts-expect-error JavaScript runtime module intentionally has no declarations.
import {
  isThreadCompactionForced,
  preflightProviderPayload,
} from "../../../../../runtime/kernel/agent-runtime/context-budget.js";
// @ts-expect-error JavaScript runtime module intentionally has no declarations.
import { executeWithContextOverflowRecovery } from "../../../../../runtime/kernel/agent-runtime/context-overflow-recovery.js";

const CONTEXT_WINDOW = 272_000;
const THREAD_KEY = "general-parent";

type StoredMessage = {
  entryId: string;
  timestamp: number;
  role: "user" | "assistant";
  content: string;
};

type FakeStore = {
  histories: Map<string, StoredMessage[]>;
  compactedHistories: Map<string, StoredMessage[]>;
  handoffs: Array<{
    threadKey: string;
    customType: string;
    content: unknown;
    eventId?: string;
  }>;
  loadThreadMessages: (threadKey: string) => StoredMessage[];
  appendThreadCustomMessage: (args: {
    threadKey: string;
    customType: string;
    content: unknown;
    eventId?: string;
  }) => void;
  listThreadActivity: () => never[];
  applyCompaction: (threadKey: string) => void;
};

const storedUser = (threadKey: string, content: string): StoredMessage => ({
  entryId: `${threadKey}-user`,
  timestamp: 1,
  role: "user",
  content,
});

const createStore = (
  histories: Record<string, StoredMessage[]>,
  compactedHistories: Record<string, StoredMessage[]>,
): FakeStore => {
  const liveHistories = new Map(Object.entries(histories));
  const compacted = new Map(Object.entries(compactedHistories));
  return {
    histories: liveHistories,
    compactedHistories: compacted,
    handoffs: [],
    loadThreadMessages: (threadKey) => [
      ...(liveHistories.get(threadKey) ?? []),
    ],
    appendThreadCustomMessage(args) {
      this.handoffs.push(args);
    },
    listThreadActivity: () => [],
    applyCompaction(threadKey) {
      const replacement = compacted.get(threadKey);
      if (replacement) liveHistories.set(threadKey, [...replacement]);
    },
  };
};

/**
 * Mirrors the live failure's single 230-provider-turn tool loop. The strings
 * are deliberately sized so 229 records fit under the 82% provider-input
 * budget while the 230th crosses it.
 */
const buildToolLoopPayload = (count: number) => ({
  input: Array.from({ length: count }, (_, index) => ({
    type: "tool_result",
    call_id: `call-${index}`,
    output: "x".repeat(2_865),
  })),
});

const createHarness = (args: {
  store: FakeStore;
  threadKey?: string;
  execute: (resume?: boolean) => Promise<{
    finalText: string;
    errorMessage?: string;
  }>;
}) => {
  const threadKey = args.threadKey ?? THREAD_KEY;
  const agent = {
    state: {
      messages: [
        {
          role: "user",
          content: "Continue the task.",
          timestamp: 1,
        },
      ],
    },
  };
  const onStatus = vi.fn();
  const notifyCompacted = vi.fn();
  const recordStatus = vi.fn(() => ({ type: "status" }));
  const opts = {
    store: args.store,
    conversationId: "conversation-1",
    agentType: "general",
    resolvedLlm: {
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        contextWindow: CONTEXT_WINDOW,
      },
    },
    callbacks: { onStatus },
  };
  return {
    agent,
    notifyCompacted,
    onStatus,
    recordStatus,
    run: () =>
      executeWithContextOverflowRecovery({
        execute: args.execute,
        agent,
        opts,
        threadKey,
        runId: `run-${threadKey}`,
        runEvents: { recordStatus },
        session: { notifyCompacted },
      }),
  };
};

describe("Pi-loop context overflow recovery", () => {
  beforeEach(() => {
    runCompactionWithHooksMock.mockReset();
  });

  it("preflights a 230-tool-call single attempt before provider dispatch", () => {
    expect(() =>
      preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(229), {
        contextWindow: CONTEXT_WINDOW,
      }),
    ).not.toThrow();

    expect(() =>
      preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toThrow(/Context preflight context_length_exceeded/);
  });

  it("catches a thrown preflight, forces compaction, rebuilds history, and retries", async () => {
    const compactedTail = storedUser(THREAD_KEY, "Compacted durable tail.");
    const store = createStore(
      { [THREAD_KEY]: [storedUser(THREAD_KEY, "Large durable history.")] },
      { [THREAD_KEY]: [compactedTail] },
    );
    runCompactionWithHooksMock.mockImplementation(
      async ({ threadKey }: { threadKey: string }) => {
        expect(isThreadCompactionForced(threadKey)).toBe(true);
        store.applyCompaction(threadKey);
        return { compacted: true };
      },
    );

    const execute = vi
      .fn<(resume?: boolean) => Promise<{ finalText: string }>>()
      .mockImplementationOnce(async () => {
        preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
          contextWindow: CONTEXT_WINDOW,
        });
        return { finalText: "unreachable" };
      })
      .mockImplementationOnce(async (resume) => {
        expect(resume).toBe(true);
        preflightProviderPayload(
          THREAD_KEY,
          { input: [{ role: "user", content: "Compacted durable tail." }] },
          { contextWindow: CONTEXT_WINDOW },
        );
        return { finalText: "Recovered after compaction." };
      });
    const harness = createHarness({ store, execute });

    await expect(harness.run()).resolves.toEqual({
      finalText: "Recovered after compaction.",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runCompactionWithHooksMock).toHaveBeenCalledTimes(1);
    expect(harness.notifyCompacted).toHaveBeenCalledTimes(1);
    expect(harness.agent.state.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Compacted durable tail.",
      }),
    ]);
    expect(store.handoffs).toHaveLength(0);
  });

  it("hands off when the compacted retry is still over budget without a third provider attempt", async () => {
    const stillOversized = storedUser(
      THREAD_KEY,
      JSON.stringify(buildToolLoopPayload(230)),
    );
    const store = createStore(
      { [THREAD_KEY]: [stillOversized] },
      { [THREAD_KEY]: [stillOversized] },
    );
    runCompactionWithHooksMock.mockImplementation(
      async ({ threadKey }: { threadKey: string }) => {
        store.applyCompaction(threadKey);
        return { compacted: true };
      },
    );
    const execute = vi.fn(async () => {
      preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
        contextWindow: CONTEXT_WINDOW,
      });
      return { finalText: "unreachable" };
    });
    const harness = createHarness({ store, execute });

    const result = await harness.run();

    expect(result.finalText).toContain(
      "the compacted retry grew beyond the model's safe input budget again",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runCompactionWithHooksMock).toHaveBeenCalledTimes(1);
    expect(store.handoffs).toHaveLength(1);
    expect(store.handoffs[0]).toMatchObject({
      threadKey: THREAD_KEY,
      customType: "context-overflow.recovery-handoff",
      eventId: `context-overflow-recovery:run-${THREAD_KEY}`,
    });
  });

  it("keeps forced recovery and rebuilt histories isolated across nested threads", async () => {
    const parentThread = "parent-general";
    const childThread = "child-general";
    const store = createStore(
      {
        [parentThread]: [storedUser(parentThread, "Parent large history.")],
        [childThread]: [storedUser(childThread, "Child large history.")],
      },
      {
        [parentThread]: [storedUser(parentThread, "Parent compacted tail.")],
        [childThread]: [storedUser(childThread, "Child compacted tail.")],
      },
    );
    const compactedThreads: string[] = [];
    runCompactionWithHooksMock.mockImplementation(
      async ({ threadKey }: { threadKey: string }) => {
        expect(isThreadCompactionForced(threadKey)).toBe(true);
        const sibling = threadKey === parentThread ? childThread : parentThread;
        expect(isThreadCompactionForced(sibling)).toBe(false);
        compactedThreads.push(threadKey);
        store.applyCompaction(threadKey);
        return { compacted: true };
      },
    );
    const buildExecute = (threadKey: string, finalText: string) =>
      vi
        .fn<(resume?: boolean) => Promise<{ finalText: string }>>()
        .mockImplementationOnce(async () => {
          preflightProviderPayload(threadKey, buildToolLoopPayload(230), {
            contextWindow: CONTEXT_WINDOW,
          });
          return { finalText: "unreachable" };
        })
        .mockResolvedValueOnce({ finalText });
    const parent = createHarness({
      store,
      threadKey: parentThread,
      execute: buildExecute(parentThread, "Parent recovered."),
    });
    const child = createHarness({
      store,
      threadKey: childThread,
      execute: buildExecute(childThread, "Child recovered."),
    });

    await expect(parent.run()).resolves.toEqual({
      finalText: "Parent recovered.",
    });
    expect(parent.agent.state.messages).toEqual([
      expect.objectContaining({ content: "Parent compacted tail." }),
    ]);
    expect(child.agent.state.messages).toEqual([
      expect.objectContaining({ content: "Continue the task." }),
    ]);

    await expect(child.run()).resolves.toEqual({
      finalText: "Child recovered.",
    });
    expect(parent.agent.state.messages).toEqual([
      expect.objectContaining({ content: "Parent compacted tail." }),
    ]);
    expect(child.agent.state.messages).toEqual([
      expect.objectContaining({ content: "Child compacted tail." }),
    ]);
    expect(compactedThreads).toEqual([parentThread, childThread]);
  });
});
