import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalChatHistoryService } from "../../electron/services/local-chat-history-service.js";
import type { TaskDecorationUpdatedPayload } from "../../../runtime/contracts/local-chat.js";

const services: LocalChatHistoryService[] = [];

const createService = (
  onTaskDecorationUpdated?: (payload: TaskDecorationUpdatedPayload) => void,
) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "stella-mobile-task-decoration-"),
  );
  const service = new LocalChatHistoryService({
    stellaAppDir: root,
    onTaskDecorationUpdated,
  });
  services.push(service);
  return service;
};

afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

const spawnRunningTask = (
  service: LocalChatHistoryService,
  conversationId: string,
) => {
  // Recent timestamps: a spawn older than the serializer's staleness window
  // would settle the task to "completed" and hide the decoration under test.
  const now = Date.now();
  service.appendEvent({
    conversationId,
    eventId: "user-1",
    type: "user_message",
    payload: { text: "start background work" },
    timestamp: now - 3_000,
  });
  service.appendEvent({
    conversationId,
    eventId: "agent-start",
    type: "agent-started",
    payload: {
      agentId: "agent-1",
      description: "Research flights",
      statusText: "Starting up",
    },
    timestamp: now - 2_000,
  });
  service.appendEvent({
    conversationId,
    eventId: "assistant-1",
    type: "assistant_message",
    payload: { text: "Working on it" },
    timestamp: now - 1_000,
  });
};

describe("mobile task decoration bridge", () => {
  it("attaches the published statusText to running tasks on sync pages", () => {
    const service = createService();
    const conversationId = "conversation-decoration";
    spawnRunningTask(service, conversationId);

    service.setTaskDecoration({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });

    const rows = service.listSyncMessages({ conversationId });
    const task = rows
      .flatMap((row) => row.tasks ?? [])
      .find((entry) => entry.id === "agent-1");
    expect(task).toMatchObject({
      status: "running",
      statusText: "Comparing fares",
    });
  });

  it("falls back to the folded spawn statusText once the decoration clears", () => {
    const service = createService();
    const conversationId = "conversation-decoration-clear";
    spawnRunningTask(service, conversationId);

    service.setTaskDecoration({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });
    service.setTaskDecoration({ statusTextByAgentId: {} });

    const rows = service.listSyncMessages({ conversationId });
    const task = rows
      .flatMap((row) => row.tasks ?? [])
      .find((entry) => entry.id === "agent-1");
    expect(task).toMatchObject({
      status: "running",
      statusText: "Starting up",
    });
  });

  it("broadcasts the combined snapshot and dedupes unchanged publishes", () => {
    const onTaskDecorationUpdated = vi.fn();
    const service = createService(onTaskDecorationUpdated);

    service.setTaskDecoration({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });
    expect(onTaskDecorationUpdated).toHaveBeenCalledTimes(1);
    expect(onTaskDecorationUpdated).toHaveBeenLastCalledWith({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });

    // Identical republish: silent.
    service.setTaskDecoration({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });
    expect(onTaskDecorationUpdated).toHaveBeenCalledTimes(1);

    // A cleared snapshot still broadcasts (the phone must drop stale ticks).
    service.setTaskDecoration({ statusTextByAgentId: {} });
    expect(onTaskDecorationUpdated).toHaveBeenCalledTimes(2);
    expect(onTaskDecorationUpdated).toHaveBeenLastCalledWith({
      statusTextByAgentId: {},
    });
  });

  it("sanitizes published entries — blank ids and empty text are dropped", () => {
    const onTaskDecorationUpdated = vi.fn();
    const service = createService(onTaskDecorationUpdated);

    service.setTaskDecoration({
      statusTextByAgentId: {
        "agent-1": "  Comparing fares  ",
        "  ": "orphan",
        "agent-2": "   ",
      },
    });
    expect(onTaskDecorationUpdated).toHaveBeenLastCalledWith({
      statusTextByAgentId: { "agent-1": "Comparing fares" },
    });
  });
});
