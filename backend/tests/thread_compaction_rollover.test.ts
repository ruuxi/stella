import { describe, expect, test } from "bun:test";
import { finalizeThreadCompaction } from "../convex/data/threads";

type TableName = "conversations" | "threads" | "thread_messages";

type Row = Record<string, unknown> & { _id: string };

/** Type-safe access to Convex internal mutation handler for testing */
type InternalHandler = { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> };

class InMemoryDb {
  private tables: Record<TableName, Map<string, Row>> = {
    conversations: new Map(),
    threads: new Map(),
    thread_messages: new Map(),
  };

  private tableForId = new Map<string, TableName>();
  private counters: Record<TableName, number> = {
    conversations: 0,
    threads: 0,
    thread_messages: 0,
  };

  seed(table: TableName, id: string, doc: Record<string, unknown>) {
    this.tables[table].set(id, { _id: id, ...doc });
    this.tableForId.set(id, table);
    const suffix = Number(id.split(":")[1] ?? 0);
    if (Number.isFinite(suffix) && suffix > this.counters[table]) {
      this.counters[table] = suffix;
    }
  }

  async get(id: string) {
    const table = this.tableForId.get(id);
    if (!table) return null;
    const row = this.tables[table].get(id);
    return row ? { ...row } : null;
  }

  async insert(table: TableName, doc: Record<string, unknown>) {
    const id = `${table}:${++this.counters[table]}`;
    this.tables[table].set(id, { _id: id, ...doc });
    this.tableForId.set(id, table);
    return id as unknown;
  }

  async patch(id: string, patch: Record<string, unknown>) {
    const table = this.tableForId.get(id);
    if (!table) return;
    const existing = this.tables[table].get(id);
    if (!existing) return;
    this.tables[table].set(id, { ...existing, ...patch });
  }

  async delete(id: string) {
    const table = this.tableForId.get(id);
    if (!table) return;
    this.tables[table].delete(id);
    this.tableForId.delete(id);
  }

  query(table: TableName) {
    const filters: Array<{ field: string; value: unknown }> = [];
    const db = this;

    return {
      withIndex: (_indexName: string, cb: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
        const q = {
          eq(field: string, value: unknown) {
            filters.push({ field, value });
            return q;
          },
        };
        cb(q);
        return {
          collect: async () => {
            const rows = [...db.tables[table].values()].filter((row) =>
              filters.every((filter) => row[filter.field] === filter.value),
            );
            if (table === "thread_messages") {
              rows.sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
            }
            return rows.map((row) => ({ ...row }));
          },
        };
      },
    };
  }

  all(table: TableName) {
    return [...this.tables[table].values()].map((row) => ({ ...row }));
  }
}

const makeCtx = (db: InMemoryDb) => ({ db } as unknown);

describe("thread compaction rollover", () => {
  test("main-thread finalize rolls forward to a new active Main thread with retained tail", async () => {
    const db = new InMemoryDb();
    const now = Date.now();

    db.seed("conversations", "conversations:1", {
      ownerId: "owner-1",
      isDefault: true,
      activeThreadId: "threads:1",
      createdAt: now,
      updatedAt: now,
    });

    db.seed("threads", "threads:1", {
      conversationId: "conversations:1",
      name: "Main",
      status: "active",
      summary: "old",
      messageCount: 6,
      totalTokenEstimate: 6_000,
      createdAt: now,
      lastUsedAt: now,
    });

    for (let i = 0; i < 6; i += 1) {
      db.seed("thread_messages", `thread_messages:${i + 1}`, {
        threadId: "threads:1",
        ordinal: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
        tokenEstimate: 1_000,
        createdAt: now + i,
      });
    }

    await (finalizeThreadCompaction as unknown as InternalHandler)._handler(makeCtx(db), {
      threadId: "threads:1",
      keepFromOrdinal: 4,
      summary: "new-summary",
    });

    const conversation = (await db.get("conversations:1"));
    expect(conversation.activeThreadId).not.toBe("threads:1");

    const oldThread = (await db.get("threads:1"));
    expect(oldThread.status).toBe("archived");
    expect(oldThread.summary).toBe("new-summary");
    expect(oldThread.messageCount).toBe(0);
    expect(oldThread.totalTokenEstimate).toBe(0);

    const newThreadId = conversation.activeThreadId as string;
    const newThread = (await db.get(newThreadId));
    expect(newThread.name).toBe("Main");
    expect(newThread.status).toBe("active");
    expect(newThread.summary).toBe("new-summary");
    expect(newThread.messageCount).toBe(2);
    expect(newThread.totalTokenEstimate).toBe(2_000);

    const oldThreadMessages = db
      .all("thread_messages")
      .filter((row) => row.threadId === "threads:1");
    expect(oldThreadMessages.length).toBe(0);

    const newThreadMessages = db
      .all("thread_messages")
      .filter((row) => row.threadId === newThreadId)
      .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    expect(newThreadMessages.map((row) => row.content)).toEqual(["m4", "m5"]);
    expect(newThreadMessages.map((row) => row.ordinal)).toEqual([0, 1]);
  });

  test("non-main finalize updates in place without conversation rollover", async () => {
    const db = new InMemoryDb();
    const now = Date.now();

    db.seed("conversations", "conversations:1", {
      ownerId: "owner-1",
      isDefault: true,
      activeThreadId: "threads:99",
      createdAt: now,
      updatedAt: now,
    });

    db.seed("threads", "threads:2", {
      conversationId: "conversations:1",
      name: "Research",
      status: "active",
      messageCount: 4,
      totalTokenEstimate: 4_000,
      createdAt: now,
      lastUsedAt: now,
    });

    for (let i = 0; i < 4; i += 1) {
      db.seed("thread_messages", `thread_messages:${i + 1}`, {
        threadId: "threads:2",
        ordinal: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `x${i}`,
        tokenEstimate: 1_000,
        createdAt: now + i,
      });
    }

    await (finalizeThreadCompaction as unknown as InternalHandler)._handler(makeCtx(db), {
      threadId: "threads:2",
      keepFromOrdinal: 2,
      summary: "research-summary",
    });

    const thread = (await db.get("threads:2"));
    expect(thread.status).toBe("active");
    expect(thread.summary).toBe("research-summary");
    expect(thread.messageCount).toBe(2);
    expect(thread.totalTokenEstimate).toBe(2_000);

    const conversation = (await db.get("conversations:1"));
    expect(conversation.activeThreadId).toBe("threads:99");

    const retained = db
      .all("thread_messages")
      .filter((row) => row.threadId === "threads:2")
      .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    expect(retained.map((row) => row.ordinal)).toEqual([2, 3]);
    expect(retained.map((row) => row.content)).toEqual(["x2", "x3"]);
  });

  test("main-thread finalize updates in place when conversation active thread already moved", async () => {
    const db = new InMemoryDb();
    const now = Date.now();

    db.seed("conversations", "conversations:1", {
      ownerId: "owner-1",
      isDefault: true,
      activeThreadId: "threads:99",
      createdAt: now,
      updatedAt: now,
    });

    db.seed("threads", "threads:1", {
      conversationId: "conversations:1",
      name: "Main",
      status: "active",
      summary: "old",
      messageCount: 5,
      totalTokenEstimate: 5_000,
      createdAt: now,
      lastUsedAt: now,
    });

    db.seed("threads", "threads:99", {
      conversationId: "conversations:1",
      name: "Main",
      status: "active",
      summary: "active",
      messageCount: 1,
      totalTokenEstimate: 1_000,
      createdAt: now,
      lastUsedAt: now,
    });

    for (let i = 0; i < 5; i += 1) {
      db.seed("thread_messages", `thread_messages:${i + 1}`, {
        threadId: "threads:1",
        ordinal: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `z${i}`,
        tokenEstimate: 1_000,
        createdAt: now + i,
      });
    }

    await (finalizeThreadCompaction as unknown as InternalHandler)._handler(makeCtx(db), {
      threadId: "threads:1",
      keepFromOrdinal: 3,
      summary: "updated-summary",
    });

    const conversation = (await db.get("conversations:1"));
    expect(conversation.activeThreadId).toBe("threads:99");

    const thread = (await db.get("threads:1"));
    expect(thread.status).toBe("active");
    expect(thread.summary).toBe("updated-summary");
    expect(thread.messageCount).toBe(2);
    expect(thread.totalTokenEstimate).toBe(2_000);

    const allThreads = db.all("threads");
    expect(allThreads.length).toBe(2);

    const retained = db
      .all("thread_messages")
      .filter((row) => row.threadId === "threads:1")
      .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    expect(retained.map((row) => row.ordinal)).toEqual([3, 4]);
    expect(retained.map((row) => row.content)).toEqual(["z3", "z4"]);
  });
});
