// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "../../../../runtime/contracts/local-chat.js";
import { useActivityTasks } from "@/features/chat/hooks/use-thread-activity";
import { __privateThreadActivityStore } from "@/features/chat/services/thread-activity-store";
import { getTaskAgentUpdates } from "@/features/chat/lib/event-transforms";

const runningRecord = (
  assistantMessages: string[],
  overrides: Partial<ThreadActivityRecord> = {},
): ThreadActivityRecord => ({
  threadId: "agent-1",
  conversationId: "conv-1",
  agentType: "general",
  description: "Inspect the live route",
  status: "running",
  attemptGeneration: 2,
  rootRunId: "run-2",
  startedAt: 2_000,
  assistantMessages,
  assistantMessagesUpdatedAt: 2_000 + (assistantMessages.length - 1) * 100,
  updatedAt: 2_000,
  ...overrides,
});

const assistantUpdate = (
  assistantMessages: string[],
): ThreadActivityUpdatedPayload => ({
  conversationId: "conv-1",
  assistantUpdate: {
    threadId: "agent-1",
    assistantMessages,
    reasoningSummaries: assistantMessages,
    latestMessage: assistantMessages.at(-1) ?? "",
    atMs: 2_000 + (assistantMessages.length - 1) * 100,
    attemptGeneration: 2,
    rootRunId: "run-2",
  },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

function MountedActivity() {
  const tasks = useActivityTasks("conv-1");
  const messages = tasks.flatMap((task) => [...getTaskAgentUpdates(task)]);
  return <output>{messages.join("|") || "empty"}</output>;
}

describe("mounted Activity authored-message refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let updateListener:
    | ((payload: ThreadActivityUpdatedPayload) => void)
    | undefined;
  let records: ThreadActivityRecord[];
  const oneShotCompletion = vi.fn();
  const listThreadActivity = vi.fn(async () => records);

  beforeEach(() => {
    vi.useFakeTimers();
    records = [runningRecord(["First persisted update"])];
    updateListener = undefined;
    listThreadActivity.mockClear();
    listThreadActivity.mockImplementation(async () => records);
    oneShotCompletion.mockClear();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadActivity,
          onThreadActivityUpdated: (
            listener: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            updateListener = listener;
            return () => {
              updateListener = undefined;
            };
          },
        },
        agent: { oneShotCompletion },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    __privateThreadActivityStore.resetForTests();
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("updates immediately and never invokes one-shot relay work", async () => {
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update",
    );

    records = [
      runningRecord(["First persisted update", "Second persisted update"]),
    ];
    await act(async () => {
      updateListener?.(
        assistantUpdate(["First persisted update", "Second persisted update"]),
      );
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("does not let a stale in-flight refetch roll back rapid updates", async () => {
    const slowFetch = deferred<ThreadActivityRecord[]>();
    listThreadActivity
      .mockReset()
      .mockResolvedValueOnce([runningRecord(["First persisted update"])])
      .mockReturnValueOnce(slowFetch.promise)
      .mockResolvedValueOnce([
        runningRecord([
          "First persisted update",
          "Second persisted update",
          "Third persisted update",
        ]),
      ]);

    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
      updateListener?.({ conversationId: "conv-1" });
      await vi.advanceTimersByTimeAsync(120);
    });

    await act(async () => {
      updateListener?.(
        assistantUpdate([
          "First persisted update",
          "Second persisted update",
          "Third persisted update",
        ]),
      );
      await vi.advanceTimersByTimeAsync(120);
    });
    slowFetch.resolve([runningRecord(["First persisted update"])]);
    await act(async () => {
      await slowFetch.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update|Second persisted update|Third persisted update",
    );
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("applies a newer-attempt update before the lifecycle refetch catches up", async () => {
    records = [
      runningRecord(["Previous attempt update"], {
        attemptGeneration: 1,
        rootRunId: "run-1",
        assistantMessagesUpdatedAt: 1_900,
      }),
    ];
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      updateListener?.({
        conversationId: "conv-1",
        assistantUpdate: {
          threadId: "agent-1",
          assistantMessages: ["Current attempt update"],
          reasoningSummaries: ["Current attempt update"],
          latestMessage: "Current attempt update",
          atMs: 3_000,
          attemptGeneration: 2,
          rootRunId: "run-2",
        },
      });
    });

    expect(container.querySelector("output")?.textContent).toBe(
      "Current attempt update",
    );
    expect(oneShotCompletion).not.toHaveBeenCalled();
  });

  it("does not treat transcript-only tool traffic as an authored Activity update", async () => {
    await act(async () => {
      root.render(<MountedActivity />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listThreadActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      updateListener?.({
        conversationId: "conv-1",
        transcriptUpdate: {
          threadId: "agent-1",
          entryId: "tool-result-entry",
          atMs: 2_500,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(listThreadActivity).toHaveBeenCalledTimes(1);
    expect(container.querySelector("output")?.textContent).toBe(
      "First persisted update",
    );
  });
});
