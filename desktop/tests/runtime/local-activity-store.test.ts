import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "../../../runtime/contracts/local-chat";
import {
  __privateLocalActivityStore,
  subscribeToLocalActivityWindow,
  type LocalActivityWindowSnapshot,
} from "@/app/chat/services/local-activity-store";

type ActivityPayload = {
  activities: EventRecord[];
  latestMessageTimestampMs: number | null;
};

const activityWindow = (
  activities: EventRecord[],
  latestMessageTimestampMs: number | null = null,
): ActivityPayload => ({
  activities,
  latestMessageTimestampMs,
});

type FakeElectronApi = {
  localChat: {
    listActivity: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => Promise<ActivityPayload>;
    onUpdated: (
      listener: (payload: LocalChatUpdatedPayload | null) => void,
    ) => () => void;
  };
};

const makeAgentStarted = (
  id: string,
  timestamp: number,
  agentId: string,
): EventRecord => ({
  _id: id,
  timestamp,
  type: "agent-started",
  payload: { agentId, description: "task", agentType: "general" },
});

const makeAgentCompleted = (
  id: string,
  timestamp: number,
  agentId: string,
): EventRecord => ({
  _id: id,
  timestamp,
  type: "agent-completed",
  payload: { agentId, result: "Done" },
});

const installFakeElectronApi = (api: FakeElectronApi): (() => void) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { electronAPI: FakeElectronApi } }).window = {
    electronAPI: api,
  };
  return () => {
    if (previous === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous;
    }
  };
};

const waitFor = async (
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> => {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
  assertion();
};

afterEach(() => {
  __privateLocalActivityStore.resetForTests();
});

describe("local-activity-store", () => {
  it("subscribes to the latest snapshot and refreshes on localChat:updated", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listActivity = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return activityWindow(
          [makeAgentStarted("ev-1", 1_000, "agent-1")],
          1_500,
        );
      }
      return activityWindow(
        [
          makeAgentStarted("ev-1", 1_000, "agent-1"),
          makeAgentCompleted("ev-2", 1_010, "agent-1"),
        ],
        1_500,
      );
    });
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listActivity, onUpdated },
    });

    try {
      const snapshots: LocalActivityWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalActivityWindow(
        { conversationId: "c1", limit: 500 },
        (snapshot) => snapshots.push(snapshot),
      );

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) =>
              snapshot.hasLoaded && snapshot.window.activities.length === 1,
          ),
        ).toBe(true),
      );

      updateListener?.({
        conversationId: "c1",
        event: { _id: "ev-2", timestamp: 1_010, type: "agent-completed" },
      });

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) => snapshot.window.activities.length === 2,
          ),
        ).toBe(true),
      );

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("queues a follow-up refresh when an update fires during an in-flight read", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let resolveFirst: ((value: ActivityPayload) => void) | null = null;
    let resolveSecond: ((value: ActivityPayload) => void) | null = null;
    let call = 0;
    const listActivity = vi.fn().mockImplementation(
      () =>
        new Promise<ActivityPayload>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else if (call === 2) resolveSecond = resolve;
          else resolve(activityWindow([]));
        }),
    );
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listActivity, onUpdated },
    });

    try {
      const snapshots: LocalActivityWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalActivityWindow(
        { conversationId: "c1", limit: 500 },
        (snapshot) => snapshots.push(snapshot),
      );

      await waitFor(() => expect(call).toBe(1));

      updateListener?.({
        conversationId: "c1",
        event: { _id: "ev-2", timestamp: 1_010, type: "agent-completed" },
      });
      await Promise.resolve();
      expect(call).toBe(1);

      resolveFirst?.(
        activityWindow([makeAgentStarted("ev-1", 1_000, "agent-1")]),
      );

      await waitFor(() => expect(call).toBe(2));

      resolveSecond?.(
        activityWindow(
          [
            makeAgentStarted("ev-1", 1_000, "agent-1"),
            makeAgentCompleted("ev-2", 1_010, "agent-1"),
          ],
          1_500,
        ),
      );

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) =>
              snapshot.hasLoaded && snapshot.window.activities.length === 2,
          ),
        ).toBe(true),
      );

      unsubscribe();
    } finally {
      restore();
    }
  });
});
