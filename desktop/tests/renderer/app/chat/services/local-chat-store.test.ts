import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalHistoryMessages,
  buildLocalSyncMessages,
  getLocalEventCount,
  getLocalSyncCheckpoint,
  getOrCreateLocalConversationId,
  listLocalEvents,
  setLocalSyncCheckpoint,
  subscribeToLocalChatUpdates,
} from "../../../../../src/app/chat/services/local-chat-store";
import type { EventRecord } from "../../../../../src/app/chat/lib/event-transforms";

type LocalChatApiMock = NonNullable<typeof window.electronAPI>["localChat"];

const installLocalChatApiMock = () => {
  const listeners = new Set<() => void>();
  const events: EventRecord[] = [
    {
      _id: "user-1",
      timestamp: 1,
      type: "user_message",
      payload: { text: "Hello", contextText: "Hello\n\n[1:00 PM, Mar 24]" },
    },
    {
      _id: "assistant-1",
      timestamp: 2,
      type: "assistant_message",
      payload: { text: "Hi there", contextText: "Hi there\n\n[5:00 PM, Dec 31]" },
    },
  ];
  let checkpoint: string | null = null;

  const api: LocalChatApiMock = {
    getOrCreateDefaultConversationId: vi.fn(async () => "conv-default"),
    listEvents: vi.fn(async () => events),
    getEventCount: vi.fn(async () => events.length),
    persistDiscoveryWelcome: vi.fn(async () => ({ ok: true as const })),
    listSyncMessages: vi.fn(async () => [
      {
        localMessageId: "user-1",
        role: "user" as const,
        text: "Hello\n\n[1:00 PM, Mar 24]",
        timestamp: 1,
      },
      {
        localMessageId: "assistant-1",
        role: "assistant" as const,
        text: "Hi there",
        timestamp: 2,
      },
    ]),
    getSyncCheckpoint: vi.fn(async () => checkpoint),
    setSyncCheckpoint: vi.fn(async ({ localMessageId }) => {
      checkpoint = localMessageId;
      return { ok: true as const };
    }),
    onUpdated: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
  };

  window.electronAPI = {
    localChat: api,
  } as unknown as typeof window.electronAPI;

  return { api, emitUpdated: () => listeners.forEach((listener) => listener()) };
};

describe("local-chat-store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installLocalChatApiMock();
  });

  it("gets or creates the default conversation id", async () => {
    await expect(getOrCreateLocalConversationId()).resolves.toBe("conv-default");
  });

  it("lists local events", async () => {
    await expect(listLocalEvents("conv-default")).resolves.toHaveLength(2);
  });

  it("gets local event count", async () => {
    await expect(getLocalEventCount("conv-default")).resolves.toBe(2);
  });

  it("builds local history messages", async () => {
    await expect(buildLocalHistoryMessages("conv-default")).resolves.toEqual([
      { role: "user", content: "Hello\n\n[1:00 PM, Mar 24]" },
      { role: "assistant", content: "Hi there\n\n[5:00 PM, Dec 31]" },
    ]);
  });

  it("builds local sync messages", async () => {
    await expect(buildLocalSyncMessages("conv-default")).resolves.toHaveLength(2);
  });

  it("reads and writes the sync checkpoint", async () => {
    await expect(getLocalSyncCheckpoint("conv-default")).resolves.toBeNull();
    await setLocalSyncCheckpoint("conv-default", "assistant-1");
    await expect(getLocalSyncCheckpoint("conv-default")).resolves.toBe("assistant-1");
  });

  it("subscribes to local chat updates", () => {
    const { emitUpdated } = installLocalChatApiMock();
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalChatUpdates(listener);

    emitUpdated();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitUpdated();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
