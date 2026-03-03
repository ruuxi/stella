import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlRuntimeStore } from "./jsonl_store.js";

const fileSafeId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const appendJsonl = (filePath: string, value: unknown): void => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
};

const tempHomes: string[] = [];

const createTempHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-jsonl-store-"));
  tempHomes.push(dir);
  return dir;
};

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("JsonlRuntimeStore", () => {
  it("replays existing thread JSONL into sqlite index on startup", () => {
    const stellaHome = createTempHome();
    const conversationId = "conv/startup-sync";
    const threadPath = path.join(
      stellaHome,
      "state",
      "pi-runtime",
      "threads",
      `${fileSafeId(conversationId)}.jsonl`,
    );

    appendJsonl(threadPath, {
      timestamp: 1,
      conversationId,
      role: "user",
      content: "Hello",
    });
    appendJsonl(threadPath, {
      timestamp: 2,
      conversationId,
      role: "assistant",
      content: "Hi there",
    });
    appendJsonl(threadPath, {
      timestamp: 3,
      conversationId,
      role: "user",
      content: "How are you?",
      toolCallId: "tool-1",
    });

    const store = new JsonlRuntimeStore(stellaHome);
    try {
      const rows = store.loadThreadMessages(conversationId, 2);
      expect(rows).toEqual([
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?", toolCallId: "tool-1" },
      ]);
    } finally {
      store.close();
    }
  });

  it("dual-writes thread messages to jsonl and sqlite", () => {
    const stellaHome = createTempHome();
    const conversationId = "conv/dual-write";
    const threadPath = path.join(
      stellaHome,
      "state",
      "pi-runtime",
      "threads",
      `${fileSafeId(conversationId)}.jsonl`,
    );

    const store = new JsonlRuntimeStore(stellaHome);
    try {
      store.appendThreadMessage({
        timestamp: 10,
        conversationId,
        role: "user",
        content: "first",
      });
      store.appendThreadMessage({
        timestamp: 11,
        conversationId,
        role: "assistant",
        content: "second",
      });

      const threadFromSqlite = store.loadThreadMessages(conversationId, 10);
      expect(threadFromSqlite).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]);

      const jsonlLines = fs.readFileSync(threadPath, "utf-8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      expect(jsonlLines).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("replays existing memory jsonl and supports recall", () => {
    const stellaHome = createTempHome();
    const memoryPath = path.join(stellaHome, "state", "pi-runtime", "memory.jsonl");

    appendJsonl(memoryPath, {
      timestamp: 100,
      conversationId: "conv-a",
      content: "User likes coffee in the morning",
      tags: ["preference", "coffee"],
    });
    appendJsonl(memoryPath, {
      timestamp: 200,
      conversationId: "conv-b",
      content: "User prefers tea in the evening",
      tags: ["preference", "tea"],
    });

    const store = new JsonlRuntimeStore(stellaHome);
    try {
      const rows = store.recallMemories({ query: "coffee", limit: 2 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toContain("coffee");
      expect(rows[0]?.tags).toContain("coffee");
    } finally {
      store.close();
    }
  });
});
