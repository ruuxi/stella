import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalChatUpdatedPayload,
  MessageRecord,
} from "../../../runtime/contracts/local-chat";
import {
  __privateLocalMessageStore,
  subscribeToLocalMessageWindow,
  type LocalMessageWindowSnapshot,
} from "@/features/chat/services/local-message-store";

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
    listMessagesAfter?: (payload: {
      conversationId: string;
      afterTimestampMs: number;
      afterId: string;
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
  it("tail-refetches new rows via listMessagesAfter on localChat:updated", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    const listMessages = vi
      .fn()
      .mockResolvedValue(window([makeMessage("u-1", 1_000, "first")]));
    const listMessagesAfter = vi
      .fn()
      .mockResolvedValue(window([makeMessage("a-2", 1_010, "second")]));
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
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
          snapshots.some((snapshot) => snapshot.window.messages.length === 2),
        ).toBe(true),
      );

      // The update read only the changed tail — never the whole window.
      expect(listMessages).toHaveBeenCalledTimes(1);
      expect(listMessagesAfter).toHaveBeenCalledTimes(1);
      expect(listMessagesAfter).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "c1",
          afterTimestampMs: 1_000,
          afterId: "u-1",
        }),
      );
      const latest = snapshots.at(-1);
      expect(latest?.window.messages.map((m) => m._id)).toEqual([
        "u-1",
        "a-2",
      ]);
      expect(latest?.window.visibleMessageCount).toBe(2);

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("falls back to a full refetch when the update carries no event", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listMessages = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return window([makeMessage("u-1", 1_000, "first")]);
      return window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second"),
      ]);
    });
    const listMessagesAfter = vi.fn();
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));

      updateListener?.({ conversationId: "c1" });

      await waitFor(() =>
        expect(
          snapshots.some((snapshot) => snapshot.window.messages.length === 2),
        ).toBe(true),
      );
      expect(listMessagesAfter).not.toHaveBeenCalled();

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("falls back to a full refetch when the update patches an existing row", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listMessages = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return window([
          makeMessage("u-1", 1_000, "first"),
          makeMessage("a-2", 1_010, "second"),
        ]);
      }
      return window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second (patched)"),
      ]);
    });
    const listMessagesAfter = vi.fn();
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));

      // A payload patch (e.g. `selfModApplied`) re-announces the existing
      // newest row — its `(timestamp, id)` is not strictly newer than the
      // window cursor, so the after-cursor walk would miss it.
      updateListener?.({
        conversationId: "c1",
        event: { _id: "a-2", timestamp: 1_010, type: "assistant_message" },
      });

      await waitFor(() =>
        expect(
          (snapshots.at(-1)?.window.messages[1]?.payload as { text?: string })
            ?.text,
        ).toBe("second (patched)"),
      );
      expect(listMessagesAfter).not.toHaveBeenCalled();
      expect(listMessages).toHaveBeenCalledTimes(2);

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("replaces an anchor whose turn gained artifacts without growing the window", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    const listMessages = vi.fn().mockResolvedValue(
      window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second"),
      ]),
    );
    const anchorWithArtifact: MessageRecord = {
      ...makeMessage("a-2", 1_010, "second"),
      toolEvents: [{ _id: "t-3", timestamp: 1_020, type: "tool_result" }],
    };
    const listMessagesAfter = vi.fn().mockResolvedValue({
      messages: [anchorWithArtifact],
      visibleMessageCount: 1,
    });
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));

      updateListener?.({
        conversationId: "c1",
        event: { _id: "t-3", timestamp: 1_020, type: "tool_result" },
      });

      await waitFor(() =>
        expect(snapshots.at(-1)?.window.messages[1]?.toolEvents).toHaveLength(
          1,
        ),
      );
      const latest = snapshots.at(-1);
      expect(latest?.window.messages.map((m) => m._id)).toEqual([
        "u-1",
        "a-2",
      ]);
      expect(latest?.window.visibleMessageCount).toBe(2);
      expect(listMessages).toHaveBeenCalledTimes(1);

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("trims the oldest rows when tail appends exceed the window cap", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    const listMessages = vi.fn().mockResolvedValue(
      window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second"),
      ]),
    );
    const listMessagesAfter = vi
      .fn()
      .mockResolvedValue(window([makeMessage("a-3", 1_020, "third")]));
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 2 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));

      updateListener?.({
        conversationId: "c1",
        event: { _id: "a-3", timestamp: 1_020, type: "assistant_message" },
      });

      // Sliding window: the append pushes the visible count to 3, so the
      // oldest row drops — same behavior a capped full refetch always had.
      await waitFor(() =>
        expect(snapshots.at(-1)?.window.messages.map((m) => m._id)).toEqual([
          "a-2",
          "a-3",
        ]),
      );
      expect(snapshots.at(-1)?.window.visibleMessageCount).toBe(2);

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("falls back to a full refetch when the tail result saturates its cap", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listMessages = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) return window([makeMessage("u-1", 1_000, "first")]);
      return window([
        makeMessage("u-1", 1_000, "first"),
        makeMessage("a-2", 1_010, "second"),
      ]);
    });
    // A saturated changed-set may have been truncated by the store's cap
    // (TAIL_REFRESH_MAX_VISIBLE = 200) — merging it could lose rows.
    const listMessagesAfter = vi.fn().mockResolvedValue({
      messages: [makeMessage("a-2", 1_010, "second")],
      visibleMessageCount: 200,
    });
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));

      updateListener?.({
        conversationId: "c1",
        event: { _id: "a-2", timestamp: 1_010, type: "assistant_message" },
      });

      await waitFor(() =>
        expect(
          snapshots.some((snapshot) => snapshot.window.messages.length === 2),
        ).toBe(true),
      );
      expect(listMessages).toHaveBeenCalledTimes(2);

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("skips the snapshot emission when the changed tail is empty", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    const listMessages = vi
      .fn()
      .mockResolvedValue(window([makeMessage("u-1", 1_000, "first")]));
    const listMessagesAfter = vi.fn().mockResolvedValue(window([]));
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listMessages, listMessagesAfter, onUpdated },
    });

    try {
      const snapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => snapshots.push(snapshot),
      );
      await waitFor(() => expect(snapshots.at(-1)?.hasLoaded).toBe(true));
      const snapshotCountAfterLoad = snapshots.length;

      updateListener?.({
        conversationId: "c1",
        event: { _id: "x-2", timestamp: 1_010, type: "assistant_message" },
      });

      await waitFor(() => expect(listMessagesAfter).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // No visible timeline change → no listener churn.
      expect(snapshots.length).toBe(snapshotCountAfterLoad);

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
    const firstWindow = window([makeMessage("u-1", 1_000, "first")]);
    const secondWindow = window([
      makeMessage("u-0", 990, "older"),
      makeMessage("u-1", 1_000, "first"),
    ]);
    const listMessages = vi.fn().mockImplementation(
      async (payload: { maxVisibleMessages?: number }) => {
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

  it("seeds the grown window from the retained snapshot when the smaller window was torn down first", async () => {
    // Reproduces React's effect cleanup-before-setup ordering on
    // `loadOlder`: the smaller-window subscription is removed before the
    // larger one subscribes, so the live-entry seed lookup finds nothing.
    // Without the retained per-conversation cache this emits an empty
    // snapshot for a frame, remounting the list and resetting scroll.
    let resolveSecond: ((value: WindowPayload) => void) | null = null;
    const firstWindow = window([makeMessage("u-1", 1_000, "first")]);
    const secondWindow = window([
      makeMessage("u-0", 990, "older"),
      makeMessage("u-1", 1_000, "first"),
    ]);
    const listMessages = vi.fn().mockImplementation(
      async (payload: { maxVisibleMessages?: number }) => {
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
        expect(
          firstSnapshots.at(-1)?.window.messages.map((m) => m._id),
        ).toEqual(["u-1"]);
      });

      // Tear the smaller window down FIRST (deletes its live entry), then
      // subscribe the larger window — the order React uses on `loadOlder`.
      unsubscribeFirst();

      const largerSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeLarger = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 250 },
        (snapshot) => largerSnapshots.push(snapshot),
      );

      // The immediate seed must carry the prior messages — never empty.
      expect(largerSnapshots[0]?.hasLoaded).toBe(false);
      expect(largerSnapshots[0]?.window.messages.map((m) => m._id)).toEqual([
        "u-1",
      ]);
      expect(largerSnapshots[0]?.window.messages).not.toHaveLength(0);

      resolveSecond?.(secondWindow);
      await waitFor(() =>
        expect(
          largerSnapshots.at(-1)?.window.messages.map((m) => m._id),
        ).toEqual(["u-0", "u-1"]),
      );

      unsubscribeLarger();
    } finally {
      restore();
    }
  });

  it("evicts the retained window once the conversation has no live subscriptions", async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValue(window([makeMessage("u-1", 1_000, "first")]));
    const onUpdated = vi.fn().mockImplementation(() => () => undefined);
    const restore = installFakeElectronApi({
      localChat: { listMessages, onUpdated },
    });

    try {
      const firstSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => firstSnapshots.push(snapshot),
      );
      await waitFor(() => expect(firstSnapshots.at(-1)?.hasLoaded).toBe(true));

      // Tear down and let the deferred eviction microtask run (a re-key
      // resubscribe would have happened synchronously before it fires).
      unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A later fresh subscription must NOT seed from the dead
      // conversation's window — it starts empty like any cold mount.
      const laterSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeLater = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => laterSnapshots.push(snapshot),
      );
      expect(laterSnapshots[0]?.hasLoaded).toBe(false);
      expect(laterSnapshots[0]?.window.messages).toHaveLength(0);

      unsubscribeLater();
    } finally {
      restore();
    }
  });

  it("keeps the retained window when another subscription for the conversation is still live", async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValue(window([makeMessage("u-1", 1_000, "first")]));
    const onUpdated = vi.fn().mockImplementation(() => () => undefined);
    const restore = installFakeElectronApi({
      localChat: { listMessages, onUpdated },
    });

    try {
      const sidebarSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeSidebar = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => sidebarSnapshots.push(snapshot),
      );
      const fullSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeFull = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 250 },
        (snapshot) => fullSnapshots.push(snapshot),
      );
      await waitFor(() => expect(fullSnapshots.at(-1)?.hasLoaded).toBe(true));

      // One surface closes; the other keeps the conversation live, so the
      // eviction pass must leave the cache alone.
      unsubscribeSidebar();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A new smaller-window subscription can't seed from the surviving
      // 250-entry (live seeding only consults *smaller* windows), so a
      // non-empty first snapshot proves the cache survived the eviction
      // pass above.
      const smallSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeSmall = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 50 },
        (snapshot) => smallSnapshots.push(snapshot),
      );
      expect(smallSnapshots[0]?.window.messages.map((m) => m._id)).toEqual([
        "u-1",
      ]);

      unsubscribeSmall();
      unsubscribeFull();
    } finally {
      restore();
    }
  });

  it("slices an oversized retained window down to the requested size when seeding", async () => {
    const bigWindow = window([
      makeMessage("u-1", 1_000, "one"),
      makeMessage("a-2", 1_010, "two"),
      makeMessage("u-3", 1_020, "three"),
      makeMessage("a-4", 1_030, "four"),
    ]);
    let resolveSecond: ((value: WindowPayload) => void) | null = null;
    const listMessages = vi.fn().mockImplementation(
      async (payload: { maxVisibleMessages?: number }) => {
        if (payload.maxVisibleMessages === 50) return bigWindow;
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
      await waitFor(() => expect(firstSnapshots.at(-1)?.hasLoaded).toBe(true));

      // Re-key to a SMALLER window (e.g. a second surface opening the
      // conversation at one page). The seed must carry only the newest
      // `maxVisibleMessages` rows, not the whole retained window.
      unsubscribeFirst();
      const smallSnapshots: LocalMessageWindowSnapshot[] = [];
      const unsubscribeSmall = subscribeToLocalMessageWindow(
        { conversationId: "c1", maxVisibleMessages: 2 },
        (snapshot) => smallSnapshots.push(snapshot),
      );

      expect(smallSnapshots[0]?.hasLoaded).toBe(false);
      expect(smallSnapshots[0]?.window.messages.map((m) => m._id)).toEqual([
        "u-3",
        "a-4",
      ]);
      expect(smallSnapshots[0]?.window.visibleMessageCount).toBe(2);

      resolveSecond?.(
        window([
          makeMessage("u-3", 1_020, "three"),
          makeMessage("a-4", 1_030, "four"),
        ]),
      );
      await waitFor(() => expect(smallSnapshots.at(-1)?.hasLoaded).toBe(true));

      unsubscribeSmall();
    } finally {
      restore();
    }
  });
});
