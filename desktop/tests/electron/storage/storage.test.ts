import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class BetterSqlite3Mock {
    private readonly db: InstanceType<typeof DatabaseSync>;

    constructor(filePath: string, options?: { readonly?: boolean }) {
      this.db = new DatabaseSync(filePath, {
        readOnly: options?.readonly === true,
      });
    }

    exec(sql: string) {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    close() {
      this.db.close();
    }
  }

  return { default: BetterSqlite3Mock };
});

import { createDesktopDatabase } from "../../../electron/storage/database.js";
import { resetMessageStorage } from "../../../electron/storage/reset-message-storage.js";
import { ChatStore } from "../../../electron/storage/chat-store.js";
import { RuntimeStore } from "../../../electron/storage/runtime-store.js";
import { TranscriptMirror } from "../../../electron/storage/transcript-mirror.js";
import {
  RUNTIME_THREAD_NAME_POOL,
  RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS,
} from "../../../electron/core/runtime/runtime-threads.js";

const tempHomes: string[] = [];
const openDatabases = new Set<{ close(): void }>();

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-storage-"));
  tempHomes.push(dir);
  return dir;
};

const createStores = (stellaHome: string) => {
  const db = createDesktopDatabase(stellaHome);
  openDatabases.add(db);
  const mirror = new TranscriptMirror(path.join(stellaHome, "state"));
  const close = () => {
    if (!openDatabases.has(db)) {
      return;
    }
    openDatabases.delete(db);
    db.close();
  };
  return {
    db,
    chatStore: new ChatStore(db, mirror),
    runtimeStore: new RuntimeStore(db, mirror),
    close,
  };
};

afterEach(() => {
  vi.useRealTimers();
  for (const db of openDatabases) {
    db.close();
  }
  openDatabases.clear();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
});

describe("storage", () => {
  it("stores chat and runtime data in one shared sqlite file while mirroring transcripts to JSONL", () => {
    const stellaHome = createTempHome();
    const { chatStore, runtimeStore, close } = createStores(stellaHome);

    chatStore.appendEvent({
      conversationId: "conv-1",
      type: "user_message",
      eventId: "u-1",
      timestamp: 1,
      deviceId: "device-1",
      payload: { text: "hello" },
    });
    chatStore.appendEvent({
      conversationId: "conv-1",
      type: "assistant_message",
      eventId: "a-2",
      timestamp: 2,
      payload: { text: "hi" },
    });
    runtimeStore.appendThreadMessage({
      timestamp: 3,
      threadKey: "conv-1",
      role: "assistant",
      content: "runtime note",
    });

    expect(fs.existsSync(path.join(stellaHome, "state", "stella.sqlite"))).toBe(true);
    expect(chatStore.listEvents("conv-1", 10).map((event) => event._id)).toEqual(["u-1", "a-2"]);
    expect(runtimeStore.loadThreadMessages("conv-1")).toEqual([
      { role: "assistant", content: "runtime note" },
    ]);

    const chatTranscriptPath = path.join(
      stellaHome,
      "state",
      "transcripts",
      "chat",
      "conv-1.jsonl",
    );
    const runtimeTranscriptPath = path.join(
      stellaHome,
      "state",
      "transcripts",
      "runtime",
      "threads",
      "conv-1.jsonl",
    );

    expect(fs.existsSync(chatTranscriptPath)).toBe(true);
    expect(fs.existsSync(runtimeTranscriptPath)).toBe(true);

    close();
  });

  it("preserves full chat history and persists sync metadata", () => {
    const stellaHome = createTempHome();
    const { chatStore, close } = createStores(stellaHome);

    for (let index = 1; index <= 2002; index += 1) {
      chatStore.appendEvent({
        conversationId: "conv-trim",
        type: "user_message",
        eventId: `e-${index}`,
        timestamp: index,
        payload: { text: `message-${index}` },
      });
    }
    chatStore.setSyncCheckpoint("conv-trim", "e-2002");

    const defaultConversationId = chatStore.getOrCreateDefaultConversationId();
    expect(chatStore.getOrCreateDefaultConversationId()).toBe(defaultConversationId);
    expect(chatStore.getEventCount("conv-trim")).toBe(2002);
    expect(chatStore.listEvents("conv-trim", 5000)[0]?._id).toBe("e-1");
    expect(chatStore.getSyncCheckpoint("conv-trim")).toBe("e-2002");

    close();
  });

  it("supports memory recall and archives replaced runtime threads", () => {
    const stellaHome = createTempHome();
    const { runtimeStore, close } = createStores(stellaHome);

    runtimeStore.saveMemory({
      conversationId: "conv-a",
      content: "User likes coffee in the morning",
      tags: ["preference", "coffee"],
    });
    runtimeStore.appendThreadMessage({
      timestamp: 1,
      threadKey: "conv/archive",
      role: "user",
      content: "first",
    });
    runtimeStore.appendThreadMessage({
      timestamp: 2,
      threadKey: "conv/archive",
      role: "assistant",
      content: "second",
    });

    const archivedPath = runtimeStore.archiveAndReplaceThreadMessages("conv/archive", [
      {
        timestamp: 3,
        threadKey: "conv/archive",
        role: "assistant",
        content: "summary",
      },
    ]);

    expect(archivedPath).toBeTruthy();
    expect(fs.existsSync(archivedPath!)).toBe(true);
    expect(runtimeStore.loadThreadMessages("conv/archive")).toEqual([
      { role: "assistant", content: "summary" },
    ]);
    expect(runtimeStore.recallMemories({ query: "coffee", limit: 2 })[0]?.content).toContain("coffee");
    expect(fs.existsSync(path.join(
      stellaHome,
      "state",
      "transcripts",
      "runtime",
      "memories.jsonl",
    ))).toBe(true);

    close();
  });

  it("preserves self-mod run metadata when rebuilding runtime run transcripts from sqlite", () => {
    const stellaHome = createTempHome();
    const initial = createStores(stellaHome);
    initial.runtimeStore.recordRunEvent({
      timestamp: 1,
      runId: "run-self-mod",
      conversationId: "conv-1",
      agentType: "orchestrator",
      seq: 1,
      type: "run_end",
      finalText: "Applied changes",
      selfModApplied: {
        featureId: "feature-123",
        files: ["src/app.tsx", "src/theme.css"],
        batchIndex: 2,
      },
    });
    initial.close();

    const runTranscriptPath = path.join(
      stellaHome,
      "state",
      "transcripts",
      "runtime",
      "runs",
      "run-self-mod.jsonl",
    );
    fs.unlinkSync(runTranscriptPath);

    const reopened = createStores(stellaHome);
    reopened.runtimeStore.recordRunEvent({
      timestamp: 2,
      runId: "run-self-mod",
      conversationId: "conv-1",
      agentType: "orchestrator",
      seq: 2,
      type: "stream",
      chunk: "follow-up",
    });

    const transcriptRows = fs
      .readFileSync(runTranscriptPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(transcriptRows[0]?.selfModApplied).toEqual({
      featureId: "feature-123",
      files: ["src/app.tsx", "src/theme.css"],
      batchIndex: 2,
    });
    reopened.close();
  });

  it("does not rebuild all transcript mirrors on startup", () => {
    const stellaHome = createTempHome();
    const initial = createStores(stellaHome);
    initial.runtimeStore.appendThreadMessage({
      timestamp: 1,
      threadKey: "conv-lazy",
      role: "user",
      content: "hello",
    });
    initial.close();

    const runtimeTranscriptPath = path.join(
      stellaHome,
      "state",
      "transcripts",
      "runtime",
      "threads",
      "conv-lazy.jsonl",
    );
    fs.unlinkSync(runtimeTranscriptPath);

    const reopened = createStores(stellaHome);
    expect(fs.existsSync(runtimeTranscriptPath)).toBe(false);
    reopened.close();
  });

  it("removes sqlite and transcript mirror files while preserving other state files", async () => {
    const stellaHome = createTempHome();
    const { chatStore, runtimeStore, close } = createStores(stellaHome);

    chatStore.appendEvent({
      conversationId: "conv-reset",
      type: "user_message",
      eventId: "e-1",
      timestamp: 1,
      payload: { text: "hello" },
    });
    runtimeStore.appendThreadMessage({
      timestamp: 2,
      threadKey: "conv-reset",
      role: "assistant",
      content: "hi",
    });

    const stateDir = path.join(stellaHome, "state");
    fs.writeFileSync(path.join(stateDir, "preferences.json"), "{}");

    close();

    fs.writeFileSync(path.join(stateDir, "stella.sqlite-wal"), "");
    fs.writeFileSync(path.join(stateDir, "stella.sqlite-shm"), "");

    await resetMessageStorage(stellaHome);

    expect(fs.existsSync(path.join(stateDir, "stella.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "stella.sqlite-wal"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "stella.sqlite-shm"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "preferences.json"))).toBe(true);
  });

  it("reuses named runtime threads, evicts the oldest active one, and tracks reminder state", () => {
    const { runtimeStore, close } = createStores(createTempHome());
    const conversationId = "conv-threads";
    const created = Array.from({ length: 16 }, (_, index) => {
      vi.setSystemTime(new Date(`2026-03-09T12:00:${String(index).padStart(2, "0")}.000Z`));
      return runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType: "general",
      });
    });

    const oldest = created[0]!;
    for (const [index, thread] of created.slice(1).entries()) {
      vi.setSystemTime(new Date(`2026-03-09T13:00:${String(index).padStart(2, "0")}.000Z`));
      runtimeStore.touchThread(thread.threadId);
    }

    const activeBefore = runtimeStore.listActiveThreads(conversationId);
    const nextName = RUNTIME_THREAD_NAME_POOL.find((name) =>
      !activeBefore.some((thread) => thread.name === name));

    expect(nextName).toBeTruthy();
    expect(runtimeStore.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadName: created[1]!.threadName,
    }).reused).toBe(true);

    const fresh = runtimeStore.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadName: nextName,
    });

    const activeAfter = runtimeStore.listActiveThreads(conversationId);
    expect(activeAfter).toHaveLength(16);
    expect(activeAfter.some((thread) => thread.name === fresh.threadName)).toBe(true);
    expect(activeAfter.some((thread) => thread.name === oldest.threadName)).toBe(false);

    expect(runtimeStore.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(true);
    runtimeStore.updateOrchestratorReminderCounter({
      conversationId,
      resetTo: 0,
    });
    expect(runtimeStore.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(false);
    runtimeStore.updateOrchestratorReminderCounter({
      conversationId,
      incrementBy: RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS,
    });
    expect(runtimeStore.getOrchestratorReminderState(conversationId).shouldInjectDynamicReminder).toBe(true);

    close();
  });
});
