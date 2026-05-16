import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "../../../runtime/contracts/local-chat";
import {
  __privateLocalFilesStore,
  subscribeToLocalFilesWindow,
  type LocalFilesWindowSnapshot,
} from "@/app/chat/services/local-files-store";

type FilesPayload = {
  files: EventRecord[];
};

const filesWindow = (files: EventRecord[]): FilesPayload => ({ files });

type FakeElectronApi = {
  localChat: {
    listFiles: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => Promise<FilesPayload>;
    onUpdated: (
      listener: (payload: LocalChatUpdatedPayload | null) => void,
    ) => () => void;
  };
};

const makeToolResult = (
  id: string,
  timestamp: number,
  path: string,
): EventRecord => ({
  _id: id,
  timestamp,
  type: "tool_result",
  payload: {
    toolName: "apply_patch",
    fileChanges: [{ kind: { type: "create" }, path }],
  },
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
  __privateLocalFilesStore.resetForTests();
});

describe("local-files-store", () => {
  it("subscribes to the latest snapshot and refreshes on localChat:updated", async () => {
    let updateListener:
      | ((payload: LocalChatUpdatedPayload | null) => void)
      | null = null;
    let call = 0;
    const listFiles = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return filesWindow([makeToolResult("ev-1", 1_000, "/a.ts")]);
      }
      return filesWindow([
        makeToolResult("ev-1", 1_000, "/a.ts"),
        makeToolResult("ev-2", 1_010, "/b.ts"),
      ]);
    });
    const onUpdated = vi.fn().mockImplementation((listener) => {
      updateListener = listener;
      return () => {
        updateListener = null;
      };
    });
    const restore = installFakeElectronApi({
      localChat: { listFiles, onUpdated },
    });

    try {
      const snapshots: LocalFilesWindowSnapshot[] = [];
      const unsubscribe = subscribeToLocalFilesWindow(
        { conversationId: "c1", limit: 500 },
        (snapshot) => snapshots.push(snapshot),
      );

      await waitFor(() =>
        expect(
          snapshots.some(
            (snapshot) =>
              snapshot.hasLoaded && snapshot.window.files.length === 1,
          ),
        ).toBe(true),
      );

      updateListener?.({
        conversationId: "c1",
        event: { _id: "ev-2", timestamp: 1_010, type: "tool_result" },
      });

      await waitFor(() =>
        expect(
          snapshots.some((snapshot) => snapshot.window.files.length === 2),
        ).toBe(true),
      );

      unsubscribe();
    } finally {
      restore();
    }
  });

  it("seeds a larger active window from the smaller loaded snapshot while loading older files", async () => {
    let resolveSecond: ((value: FilesPayload) => void) | null = null;
    const firstWindow = filesWindow([makeToolResult("ev-1", 1_000, "/a.ts")]);
    const secondWindow = filesWindow([
      makeToolResult("ev-0", 990, "/older.ts"),
      makeToolResult("ev-1", 1_000, "/a.ts"),
    ]);
    const listFiles = vi.fn().mockImplementation(
      async (payload: { limit?: number }) => {
        if (payload.limit === 500) return firstWindow;
        return await new Promise<FilesPayload>((resolve) => {
          resolveSecond = resolve;
        });
      },
    );
    const onUpdated = vi.fn().mockImplementation(() => () => undefined);
    const restore = installFakeElectronApi({
      localChat: { listFiles, onUpdated },
    });

    try {
      const firstSnapshots: LocalFilesWindowSnapshot[] = [];
      const unsubscribeFirst = subscribeToLocalFilesWindow(
        { conversationId: "c1", limit: 500 },
        (snapshot) => firstSnapshots.push(snapshot),
      );

      await waitFor(() => {
        expect(firstSnapshots.at(-1)?.hasLoaded).toBe(true);
        expect(
          firstSnapshots.at(-1)?.window.files.map((event) => event._id),
        ).toEqual(["ev-1"]);
      });

      const largerSnapshots: LocalFilesWindowSnapshot[] = [];
      const unsubscribeLarger = subscribeToLocalFilesWindow(
        { conversationId: "c1", limit: 1000 },
        (snapshot) => largerSnapshots.push(snapshot),
      );

      // Grow-fetch is mid-flight; the new entry must surface the prior
      // window's files (with hasLoaded=false) instead of briefly
      // showing an empty list.
      expect(largerSnapshots[0]?.hasLoaded).toBe(false);
      expect(
        largerSnapshots[0]?.window.files.map((event) => event._id),
      ).toEqual(["ev-1"]);

      resolveSecond?.(secondWindow);
      await waitFor(() =>
        expect(
          largerSnapshots.at(-1)?.window.files.map((event) => event._id),
        ).toEqual(["ev-0", "ev-1"]),
      );

      unsubscribeLarger();
      unsubscribeFirst();
    } finally {
      restore();
    }
  });
});
