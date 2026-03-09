import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonlRuntimeStore } from "../../../packages/stella-runtime/src/jsonl_store.js";
import {
  RUNTIME_THREAD_NAME_POOL,
  RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS,
} from "../../../packages/stella-runtime/src/runtime-threads.js";

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-runtime-threads-"));
  tempHomes.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
});

describe("JsonlRuntimeStore thread registry", () => {
  it("reuses named threads and evicts the oldest active thread when the cap is reached", () => {
    const store = new JsonlRuntimeStore(createTempHome());
    const conversationId = "conv-1";
    const created = Array.from({ length: 16 }, (_, index) => {
      vi.setSystemTime(new Date(`2026-03-09T12:00:${String(index).padStart(2, "0")}.000Z`));
      return store.resolveOrCreateActiveThread({
        conversationId,
        agentType: "general",
      });
    });

    const forcedOldest = created[0]!;
    for (const [index, thread] of created.slice(1).entries()) {
      vi.setSystemTime(new Date(`2026-03-09T13:00:${String(index).padStart(2, "0")}.000Z`));
      store.touchThread(thread.threadId);
    }

    const activeBefore = store.listActiveThreads(conversationId);
    const oldestName = forcedOldest.threadName;
    const nextName = RUNTIME_THREAD_NAME_POOL.find((name) =>
      !activeBefore.some((thread) => thread.name === name));

    expect(activeBefore).toHaveLength(16);
    expect(nextName).toBeTruthy();

    const reused = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadName: created[1]!.threadName,
    });
    expect(reused.reused).toBe(true);
    expect(reused.threadId).toBe(created[1]!.threadId);

    const fresh = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadName: nextName,
    });

    const activeAfter = store.listActiveThreads(conversationId);
    expect(activeAfter).toHaveLength(16);
    expect(activeAfter.some((thread) => thread.name === fresh.threadName)).toBe(true);
    expect(activeAfter.some((thread) => thread.name === oldestName)).toBe(false);

    store.close();
  });

  it("tracks reminder injection state across turns", () => {
    const store = new JsonlRuntimeStore(createTempHome());
    const conversationId = "conv-2";

    expect(store.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(true);

    store.updateOrchestratorReminderCounter({
      conversationId,
      resetTo: 0,
    });
    expect(store.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(false);

    store.updateOrchestratorReminderCounter({
      conversationId,
      incrementBy: RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS - 1,
    });
    expect(store.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(false);

    store.updateOrchestratorReminderCounter({
      conversationId,
      incrementBy: 1,
    });
    expect(store.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(true);

    store.close();
  });
});
