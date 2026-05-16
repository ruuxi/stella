import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalChatUpdatedPayload,
  MessageRecord,
} from "../../../runtime/contracts/local-chat";
import {
  __privateLocalMessageStore,
  subscribeToLocalMessageWindow,
  type LocalMessageWindowSnapshot,
} from "@/app/chat/services/local-message-store";

type WindowPayload = {
  messages: MessageRecord[];
  visibleMessageCount: number;
};

const window = (messages: MessageRecord[]): WindowPayload => ({
  messages,
  visibleMessageCount: messages.length,
});

type FakeElectronApi = {
  localChat: {
    listMessages: (payload: {
      conversationId: string;
      maxVisibleMessages?: number;
    }) => Promise<WindowPayload>;
    onUpdated: (
      listener: (payload: LocalChatUpdatedPayload | null) => void,
    ) => () => void;
  };
};

const makeMessage = (id: string, timestamp: number, text: string): MessageRecord => ({
  _id: id,
  timestamp,
  type: id.startsWith("u") ? "user_message" : "assistant_message",
  payload: { text },
  toolEvents: [],
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
  __privateLocalMessageStore.resetForTests();
});

describe("local-message-store", () => {
  it("subscribes to the latest snapshot and refreshes on localChat:updated", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listMessages = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return window([makeMessage("u-1", 1_000, "first")]);
      }
      return window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second"),
      ]);
    });
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) =>
              snapshot.hasLoaded && snapshot.window.messages.length === 1,
          ),
        ).toBe(true),
      );

      updateListener?.({
        conversationId: "c1",
        event: { _id: "a-2", timestamp: 1_010, type: "assistant_message" },
      });

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) => snapshot.window.messages.length === 2,
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
    let resolveFirst: ((value: WindowPayload) => void) | null = null;
    let resolveSecond: ((value: WindowPayload) => void) | null = null;
    let call = 0;
    const listMessages = vi.fn().mockImplementation(
      () =>
        new Promise<WindowPayload>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else if (call === 2) resolveSecond = resolve;
          else resolve(window([]));
        }),
    );
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );

      // Wait for the first fetch to have been kicked off (call=1).
      await waitFor(() => expect(call).toBe(1));

      // Update fires WHILE the first fetch is still pending. The
      // store should set the pending-refetch flag instead of dropping
      // it on the floor.
      updateListener?.({
        conversationId: "c1",
        event: { _id: "a-2", timestamp: 1_010, type: "assistant_message" },
      });
      // Briefly let any microtasks drain — there should still be only
      // one in-flight read, not two.
      await Promise.resolve();
      expect(call).toBe(1);

      // Resolve the first read with stale data (call landed before the
      // update committed). The store should immediately re-fetch.
      resolveFirst?.(window([makeMessage("u-1", 1_000, "first")]));

      await waitFor(() => expect(call).toBe(2));

      // Resolve the second (post-update) read with the fresh window.
      resolveSecond?.(
        window([
          makeMessage("u-1", 1_000, "first"),
          makeMessage("a-2", 1_010, "second"),
        ]),
      );

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) =>
              snapshot.hasLoaded && snapshot.window.messages.length === 2,
          ),
        ).toBe(true),
      );

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("seeds a larger active window from the smaller loaded snapshot while loading older messages", async () => {
    let resolveSecond: ((value: WindowPayload) => void) | null = null;
    let call = 0;
    const firstWindow = window([makeMessage("u-1", 1_000, "first")]);
    const secondWindow = window([
      makeMessage("u-0", 990, "older"),
      makeMessage("u-1", 1_000, "first"),
    ]);
    const listMessages = vi.fn().mockImplementation(
      async (payload: { maxVisibleMessages?: number }) => {
        call += 1;
        if (payload.maxVisibleMessages === 50) return firstWindow;
        return await new Promise<WindowPayload>((resolve) => {
          resolveSecond = resolve;
        });
      },
    );
    const onUpdated = vi.fn().mockImplementation(() => () => undefined);
    const restore = installFakeElectronApi({
      localChat: { listMessages, onUpdated },
    });

    try {
      const firstSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeFirst = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => firstSnapshots.push(snapshot),
      );

      await waitFor(() => {
        expect(firstSnapshots.at(-1)?.hasLoaded).toBe(true);
        expect(firstSnapshots.at(-1)?.window.messages.map((m) => m._id)).toEqual([
          "u-1",
        ]);
      });

      const largerSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeLarger = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 250 },
        (snapshot) => largerSnapshots.push(snapshot),
      );

      expect(largerSnapshots[0]?.hasLoaded).toBe(false);
      expect(largerSnapshots[0]?.window.messages.map((m) => m._id)).toEqual([
        "u-1",
      ]);
      expect(largerSnapshots[0]?.window.messages).not.toHaveLength(0);

      resolveSecond?.(secondWindow);
      await waitFor(() =>
        expect(largerSnapshots.at(-1)?.window.messages.map((m) => m._id)).toEqual([
          "u-0",
          "u-1",
        ]),
      );

      unsubscribeLarger();
      unsubscribeFirst();
    } finally {
      restore();
    }
  });
});
