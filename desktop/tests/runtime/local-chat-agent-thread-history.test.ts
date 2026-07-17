import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalChatHistoryService } from "../../electron/services/local-chat-history-service.js";
import type { SessionStore } from "../../../runtime/kernel/storage/session-store.js";

describe("local agent thread history boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("returns only the exact persisted thread and enforces the wire bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-thread-chat-"));
    roots.push(root);
    const service = new LocalChatHistoryService({ stellaAppDir: root });
    const store = (
      service as unknown as { getStore: () => SessionStore }
    ).getStore();

    for (let index = 0; index < 305; index += 1) {
      store.appendThreadMessage({
        threadKey: "exact-agent-thread",
        timestamp: index + 1,
        role: index % 2 === 0 ? "assistant" : "toolResult",
        content: `exact-${index}`,
      });
    }
    store.appendThreadMessage({
      threadKey: "other-agent-thread",
      timestamp: 999,
      role: "assistant",
      content: "must never cross threads",
    });

    const messages = service.listAgentThreadMessages({
      threadId: "exact-agent-thread",
      limit: 5_000,
    });
    expect(messages).toHaveLength(300);
    expect(messages[0]?.content).toContain("exact-5");
    expect(messages.at(-1)?.content).toBe("exact-304");
    expect(JSON.stringify(messages)).not.toContain("must never cross threads");
    expect(() => service.listAgentThreadMessages({ threadId: "   " })).toThrow(
      /threadId is required/,
    );
    service.close();
  });
});
