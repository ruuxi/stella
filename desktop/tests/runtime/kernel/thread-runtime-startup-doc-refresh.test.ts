import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compaction-boundary refresh of pinned resident startup docs, exercised
// against the real SQLite store: mid-epoch the persisted doc copies must stay
// byte-frozen no matter how the source files change (prompt-cache stability),
// and a successful compaction must rewrite them in place from disk (same
// entry, same position) so the new epoch starts current. The same boundary
// owns the memory_summary/memory_index → memory_map migration: retired pinned
// copies are converted/removed ONLY here, never mid-epoch.

const completeSimpleMock = vi.fn();

vi.mock("../../../../runtime/ai/stream.js", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
  readAssistantText: (message: {
    content: Array<{ type: string; text?: string }>;
  }): string =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
}));

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../runtime/kernel/storage/shared.js";
import {
  maybeCompactRuntimeThread,
  resetThreadSummaryFailureTracking,
} from "../../../../runtime/kernel/thread-runtime.js";
import {
  buildStartupPromptMessages,
  persistThreadCustomMessage,
} from "../../../../runtime/kernel/agent-runtime/thread-memory.js";
import {
  buildStartupDocMessage,
  LIFE_MEMORY_MAP_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  refreshResidentStartupDocs,
} from "../../../../runtime/kernel/memory/resident-docs.js";
import {
  readMemoryMapDoc,
  readUserProfileDoc,
} from "../../../../runtime/kernel/runner/shared.js";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { awaitPreCompactionConsolidation } from "../../../../runtime/kernel/agent-runtime/dream-scheduler.js";

const LIFE_MEMORY_SUMMARY_DISPLAY_PATH =
  "~/.stella/memories/memory_summary.md";
const LIFE_MEMORY_INDEX_DISPLAY_PATH = "~/.stella/memories/memory_index.md";

const VALID_SUMMARY = [
  "## Topic",
  "Condensed summary of the backlog covering the full compacted span.",
  "## Key Points",
  "All backlog messages were reviewed and folded into this checkpoint,",
  "including the delegated workstreams and their thread ids.",
  "## Current State",
  "Work is ongoing; the latest turns remain uncompacted in the tail.",
  "## Open Items",
  "None outstanding beyond the active workstreams named above.",
].join("\n");

const createRoute = (): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id: "stella/max", contextWindow: 80_000 },
    getApiKey: async () => "auth-token",
  }) as unknown as ResolvedLlmRoute;

type TestContext = {
  rootPath: string;
  stellaDataDir: string;
  db: SqliteDatabase;
  store: SessionStore;
};

let context: TestContext;

const THREAD_KEY = "conv-refresh-1";

const writeMemoryDocs = (args: {
  profile?: string;
  memoryMap?: string;
}): void => {
  const memoriesDir = path.join(context.stellaDataDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  if (args.profile !== undefined) {
    fs.writeFileSync(path.join(memoriesDir, "profile.md"), args.profile);
  }
  if (args.memoryMap !== undefined) {
    fs.writeFileSync(path.join(memoriesDir, "memory_map.md"), args.memoryMap);
  }
};

const buildContextFromStore = () => ({
  systemPrompt: "system",
  dynamicContext: "",
  maxAgentDepth: 1,
  threadHistory: context.store.loadThreadMessages(THREAD_KEY),
  userProfile: readUserProfileDoc(context.stellaDataDir),
  memoryMap: readMemoryMapDoc(context.stellaDataDir),
});

/** Persist startup docs exactly the way run-execution does after injection. */
const persistStartupDocsFromPromptBuild = async (): Promise<number> => {
  const messages = await buildStartupPromptMessages({
    context: buildContextFromStore(),
    stellaDataDir: context.stellaDataDir,
  });
  for (const message of messages) {
    persistThreadCustomMessage(context.store, {
      threadKey: THREAD_KEY,
      customType: message.customType!,
      content: [{ type: "text", text: message.text }],
      display: false,
    });
  }
  return messages.length;
};

const persistStartupDoc = (displayPath: string, body: string): void => {
  persistThreadCustomMessage(context.store, {
    threadKey: THREAD_KEY,
    customType: "bootstrap.startup_doc",
    content: [{ type: "text", text: buildStartupDocMessage(displayPath, body) }],
    display: false,
  });
};

const appendBigConversation = (count = 40): void => {
  for (let index = 0; index < count; index += 1) {
    context.store.appendThreadMessage({
      timestamp: 10_000 + index,
      threadKey: THREAD_KEY,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index + 1} ${"x".repeat(10_000)}`,
    });
  }
};

const loadStartupDocs = () =>
  context.store
    .loadThreadMessages(THREAD_KEY)
    .filter(
      (message) =>
        message.customMessage?.customType === "bootstrap.startup_doc",
    )
    .map((message) => ({
      entryId: message.entryId,
      text:
        typeof message.customMessage!.content === "string"
          ? message.customMessage!.content
          : message.customMessage!.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n"),
    }));

const compactOnce = async (): Promise<void> => {
  completeSimpleMock.mockResolvedValue({
    content: [{ type: "text", text: VALID_SUMMARY }],
    stopReason: "stop",
  });
  const result = await maybeCompactRuntimeThread({
    store: context.store,
    threadKey: THREAD_KEY,
    resolvedLlm: createRoute(),
    agentType: "orchestrator",
    stellaDataDir: context.stellaDataDir,
  });
  expect(result).toEqual({ compacted: true });
};

describe("compaction-boundary refresh of pinned startup docs", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resetThreadSummaryFailureTracking();
    const rootPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-startup-doc-refresh-"),
    );
    const stellaDataDir = path.join(rootPath, "data");
    fs.mkdirSync(stellaDataDir, { recursive: true });
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    context = { rootPath, stellaDataDir, db, store: new SessionStore(db) };
  });

  afterEach(() => {
    try {
      (context.db as unknown as { close?: () => void }).close?.();
    } catch {
      // Best-effort teardown.
    }
    fs.rmSync(context.rootPath, { recursive: true, force: true });
  });

  it("freezes pinned docs mid-epoch and refreshes them in place at compaction", async () => {
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Bob",
      memoryMap: "# Memory map\n\n- routing snapshot v1",
    });
    expect(await persistStartupDocsFromPromptBuild()).toBe(2);
    const docsBefore = loadStartupDocs();
    expect(docsBefore).toHaveLength(2);

    appendBigConversation();

    // Mid-epoch rewrite: Remember updates the profile; Dream rewrites the
    // map. Prompt builds must inject nothing (byte-stable prefix) and the
    // persisted copies must stay byte-identical.
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Robert",
      memoryMap: "# Memory map\n\n- routing snapshot v2",
    });
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.stellaDataDir,
      }),
    ).toEqual([]);
    expect(loadStartupDocs()).toEqual(docsBefore);

    // Compaction boundary: the overlay is written and the pinned copies catch
    // up from disk — same entries, same order, fresh bytes.
    await compactOnce();

    const docsAfter = loadStartupDocs();
    expect(docsAfter).toHaveLength(2);
    expect(docsAfter.map((doc) => doc.entryId)).toEqual(
      docsBefore.map((doc) => doc.entryId),
    );
    const profileDoc = docsAfter.find((doc) =>
      doc.text.includes(LIFE_USER_PROFILE_DISPLAY_PATH),
    );
    expect(profileDoc?.text).toBe(
      buildStartupDocMessage(
        LIFE_USER_PROFILE_DISPLAY_PATH,
        "# User Profile\n\n- The user goes by Robert",
      ),
    );
    expect(profileDoc?.text).not.toContain("Bob");
    const mapDoc = docsAfter.find((doc) =>
      doc.text.includes(LIFE_MEMORY_MAP_DISPLAY_PATH),
    );
    expect(mapDoc?.text).toContain("routing snapshot v2");

    // The refreshed docs remain the head of the rebuilt window, and the next
    // prompt build still injects nothing — exactly one copy per doc, ever.
    const rebuilt = context.store.loadThreadMessages(THREAD_KEY);
    expect(
      rebuilt
        .slice(0, 2)
        .every(
          (message) =>
            message.customMessage?.customType === "bootstrap.startup_doc",
        ),
    ).toBe(true);
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.stellaDataDir,
      }),
    ).toEqual([]);
  });

  it("leaves unchanged docs byte-identical and keeps stale copies when a source vanishes", async () => {
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Bob",
      memoryMap: "# Memory map\n\n- routing snapshot v1",
    });
    await persistStartupDocsFromPromptBuild();
    const docsBefore = loadStartupDocs();

    // Delete the map source; refresh must keep the existing pinned copy
    // rather than blanking resident context, and must not touch the
    // unchanged profile doc at all.
    fs.rmSync(path.join(context.stellaDataDir, "memories", "memory_map.md"));
    const refreshed = refreshResidentStartupDocs({
      store: context.store,
      threadKey: THREAD_KEY,
      stellaDataDir: context.stellaDataDir,
    });
    expect(refreshed).toEqual({ refreshedDocs: 0, removedDocs: 0 });
    expect(loadStartupDocs()).toEqual(docsBefore);
  });

  it("keeps the step-6 shadow log invisible to injection, mid-epoch and at the boundary", async () => {
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Bob",
      memoryMap: "# Memory map\n\n- routing snapshot v1",
    });
    expect(await persistStartupDocsFromPromptBuild()).toBe(2);
    const docsBefore = loadStartupDocs();
    appendBigConversation();

    // The delta shadow pass writes ONLY memories/memory_shadow.md. That new
    // write path must never reach any injected surface: prompt builds stay
    // empty and pinned copies stay byte-identical mid-epoch...
    fs.writeFileSync(
      path.join(context.stellaDataDir, "memories", "memory_shadow.md"),
      "## Shadow pass\nSHADOW-SENTINEL proposal body",
    );
    expect(
      await buildStartupPromptMessages({
        context: buildContextFromStore(),
        stellaDataDir: context.stellaDataDir,
      }),
    ).toEqual([]);
    expect(loadStartupDocs()).toEqual(docsBefore);

    // ...and even the boundary refresh — the one moment docs MAY change —
    // never promotes the shadow file into a resident doc.
    await compactOnce();
    const docsAfter = loadStartupDocs();
    expect(docsAfter).toHaveLength(2);
    expect(
      docsAfter.some((doc) => doc.text.includes("SHADOW-SENTINEL")),
    ).toBe(false);
    expect(
      JSON.stringify(context.store.loadThreadMessages(THREAD_KEY)),
    ).not.toContain("SHADOW-SENTINEL");
  });

  it("scrubs a legacy persisted copy containing a retired comment at the boundary", () => {
    // Copies persisted before comment-stripping landed still carry the
    // graveyard; the first boundary refresh rewrites them from the (now
    // stripped) disk read even when the file itself did not change.
    writeMemoryDocs({
      memoryMap:
        "# Memory map\n\n- routing snapshot v1\n<!-- DREAM:RETIRED_SUMMARY\n- retired bullet\n-->",
    });
    persistStartupDoc(
      LIFE_MEMORY_MAP_DISPLAY_PATH,
      "# Memory map\n\n- routing snapshot v1\n<!-- DREAM:RETIRED_SUMMARY\n- retired bullet\n-->",
    );

    const refreshed = refreshResidentStartupDocs({
      store: context.store,
      threadKey: THREAD_KEY,
      stellaDataDir: context.stellaDataDir,
    });
    expect(refreshed).toEqual({ refreshedDocs: 1, removedDocs: 0 });
    const [doc] = loadStartupDocs();
    expect(doc!.text).toContain("routing snapshot v1");
    expect(doc!.text).not.toContain("retired bullet");
    expect(doc!.text).not.toContain("DREAM:RETIRED_SUMMARY");
  });

  it("updateThreadCustomMessageContent rejects unknown entries and preserves metadata", () => {
    persistThreadCustomMessage(context.store, {
      threadKey: THREAD_KEY,
      customType: "bootstrap.startup_doc",
      content: [{ type: "text", text: "doc v1" }],
      display: false,
    });
    const [doc] = loadStartupDocs();
    expect(doc).toBeDefined();

    expect(
      context.store.updateThreadCustomMessageContent({
        threadKey: THREAD_KEY,
        entryId: "missing-entry",
        content: [{ type: "text", text: "nope" }],
      }),
    ).toBe(false);

    expect(
      context.store.updateThreadCustomMessageContent({
        threadKey: THREAD_KEY,
        entryId: doc!.entryId!,
        content: [{ type: "text", text: "doc v2" }],
      }),
    ).toBe(true);
    const [updated] = loadStartupDocs();
    expect(updated!.text).toBe("doc v2");
    expect(updated!.entryId).toBe(doc!.entryId);
  });

  it("removeThreadCustomMessage deletes only custom-message entries", () => {
    persistThreadCustomMessage(context.store, {
      threadKey: THREAD_KEY,
      customType: "bootstrap.startup_doc",
      content: [{ type: "text", text: "doc v1" }],
      display: false,
    });
    context.store.appendThreadMessage({
      timestamp: 10_000,
      threadKey: THREAD_KEY,
      role: "user",
      content: "an ordinary conversation message",
    });
    const [doc] = loadStartupDocs();
    const conversationEntryId = context.store
      .loadThreadMessages(THREAD_KEY)
      .find((message) => message.role === "user")?.entryId;
    expect(conversationEntryId).toBeDefined();

    expect(
      context.store.removeThreadCustomMessage({
        threadKey: THREAD_KEY,
        entryId: "missing-entry",
      }),
    ).toBe(false);
    // A conversation entry is not a custom message; the guard refuses it.
    expect(
      context.store.removeThreadCustomMessage({
        threadKey: THREAD_KEY,
        entryId: conversationEntryId!,
      }),
    ).toBe(false);
    expect(
      context.store.removeThreadCustomMessage({
        threadKey: THREAD_KEY,
        entryId: doc!.entryId!,
      }),
    ).toBe(true);
    expect(loadStartupDocs()).toEqual([]);
    expect(
      context.store
        .loadThreadMessages(THREAD_KEY)
        .some((message) => message.role === "user"),
    ).toBe(true);
  });

  describe("memory_summary/memory_index → memory_map migration", () => {
    it("converts the retired summary copy into the map at the boundary and drops the index copy", async () => {
      // A pre-migration thread: summary + index pinned copies persisted.
      persistStartupDoc(
        LIFE_USER_PROFILE_DISPLAY_PATH,
        "# User Profile\n\n- The user goes by Bob",
      );
      persistStartupDoc(
        LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
        "# Memory summary\n\n- old focus snapshot",
      );
      persistStartupDoc(
        LIFE_MEMORY_INDEX_DISPLAY_PATH,
        "# Memory index\n\n- old routing entry",
      );
      writeMemoryDocs({
        profile: "# User Profile\n\n- The user goes by Bob",
        memoryMap: "# Memory map\n\n- seeded routing entry",
      });
      const docsBefore = loadStartupDocs();
      expect(docsBefore).toHaveLength(3);

      // Mid-epoch (post-upgrade, pre-boundary): prompt builds must inject
      // NOTHING — the retired copies stay byte-frozen and the map is
      // suppressed while they persist. The prefix is byte-identical across
      // the upgrade until the boundary.
      appendBigConversation();
      expect(
        await buildStartupPromptMessages({
          context: buildContextFromStore(),
          stellaDataDir: context.stellaDataDir,
        }),
      ).toEqual([]);
      expect(loadStartupDocs()).toEqual(docsBefore);

      // Boundary: summary entry converts IN PLACE into the map copy (same
      // entry id — it inherits the pinned head slot); index entry is removed.
      await compactOnce();

      const docsAfter = loadStartupDocs();
      expect(docsAfter).toHaveLength(2);
      const summaryEntryId = docsBefore[1]!.entryId;
      const mapDoc = docsAfter.find((doc) =>
        doc.text.includes(LIFE_MEMORY_MAP_DISPLAY_PATH),
      );
      expect(mapDoc?.entryId).toBe(summaryEntryId);
      expect(mapDoc?.text).toBe(
        buildStartupDocMessage(
          LIFE_MEMORY_MAP_DISPLAY_PATH,
          "# Memory map\n\n- seeded routing entry",
        ),
      );
      expect(
        docsAfter.some(
          (doc) =>
            doc.text.includes(LIFE_MEMORY_SUMMARY_DISPLAY_PATH) ||
            doc.text.includes(LIFE_MEMORY_INDEX_DISPLAY_PATH),
        ),
      ).toBe(false);

      // Post-migration: builds inject nothing; the pinned map is canonical.
      expect(
        await buildStartupPromptMessages({
          context: buildContextFromStore(),
          stellaDataDir: context.stellaDataDir,
        }),
      ).toEqual([]);
    });

    it("keeps retired copies frozen when no map body exists yet", () => {
      persistStartupDoc(
        LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
        "# Memory summary\n\n- old focus snapshot",
      );
      const docsBefore = loadStartupDocs();

      // No memory_map.md on disk: retiring the summary now would blank the
      // thread's only resident routing context. Keep it; retry next boundary.
      const refreshed = refreshResidentStartupDocs({
        store: context.store,
        threadKey: THREAD_KEY,
        stellaDataDir: context.stellaDataDir,
      });
      expect(refreshed).toEqual({ refreshedDocs: 0, removedDocs: 0 });
      expect(loadStartupDocs()).toEqual(docsBefore);
    });

    it("dedupes extra copies of the same doc at the boundary, keeping the head-most", () => {
      writeMemoryDocs({ memoryMap: "# Memory map\n\n- fresh entry" });
      persistStartupDoc(
        LIFE_MEMORY_MAP_DISPLAY_PATH,
        "# Memory map\n\n- head copy",
      );
      persistStartupDoc(
        LIFE_MEMORY_MAP_DISPLAY_PATH,
        "# Memory map\n\n- stale duplicate copy",
      );
      const [headDoc] = loadStartupDocs();

      const refreshed = refreshResidentStartupDocs({
        store: context.store,
        threadKey: THREAD_KEY,
        stellaDataDir: context.stellaDataDir,
      });
      expect(refreshed).toEqual({ refreshedDocs: 1, removedDocs: 1 });
      const docsAfter = loadStartupDocs();
      expect(docsAfter).toHaveLength(1);
      expect(docsAfter[0]!.entryId).toBe(headDoc!.entryId);
      expect(docsAfter[0]!.text).toContain("fresh entry");
    });

    it("drops retired copies outright when a pinned map copy already exists", () => {
      writeMemoryDocs({ memoryMap: "# Memory map\n\n- fresh entry" });
      persistStartupDoc(
        LIFE_MEMORY_MAP_DISPLAY_PATH,
        "# Memory map\n\n- fresh entry",
      );
      persistStartupDoc(
        LIFE_MEMORY_INDEX_DISPLAY_PATH,
        "# Memory index\n\n- straggler entry",
      );

      const refreshed = refreshResidentStartupDocs({
        store: context.store,
        threadKey: THREAD_KEY,
        stellaDataDir: context.stellaDataDir,
      });
      expect(refreshed).toEqual({ refreshedDocs: 0, removedDocs: 1 });
      const docsAfter = loadStartupDocs();
      expect(docsAfter).toHaveLength(1);
      expect(docsAfter[0]!.text).toContain(LIFE_MEMORY_MAP_DISPLAY_PATH);
    });
  });

  describe("consolidate-before-compact ordering (cache stability)", () => {
    const recordPendingInboxRow = (): void => {
      context.store.dreamInboxStore.recordThreadSummary({
        threadId: "thread-1",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "Delivered the widget refactor and verified tests.",
      });
    };

    it("a timed-out Dream pass changes nothing mid-epoch and compaction proceeds", async () => {
      writeMemoryDocs({
        profile: "# User Profile\n\n- The user goes by Bob",
        memoryMap: "# Memory map\n\n- routing snapshot v1",
      });
      await persistStartupDocsFromPromptBuild();
      appendBigConversation();
      const docsBefore = loadStartupDocs();
      const messageCountBefore =
        context.store.loadThreadMessages(THREAD_KEY).length;
      recordPendingInboxRow();

      // The Dream pass hangs at its provider call; the bounded await must
      // return without touching the thread or the persisted prefix.
      completeSimpleMock.mockReturnValue(new Promise(() => {}));
      const result = await awaitPreCompactionConsolidation({
        stellaDataDir: context.stellaDataDir,
        store: context.store,
        resolvedLlm: createRoute(),
        timeoutMs: 100,
      });
      expect(result.outcome).toBe("timed_out");
      expect(loadStartupDocs()).toEqual(docsBefore);
      expect(context.store.loadThreadMessages(THREAD_KEY)).toHaveLength(
        messageCountBefore,
      );
      // No completed pass: the watermark must not advance, so the missed
      // span stays covered for a later pass.
      expect(
        context.store.dreamInboxStore.readConsolidationWatermark(),
      ).toBeNull();

      // Compaction proceeds regardless of the timed-out pass.
      await compactOnce();
      expect(loadStartupDocs()).toHaveLength(2);
    });

    it("a completed pass advances the watermark; the prefix stays byte-frozen until the boundary", async () => {
      writeMemoryDocs({
        profile: "# User Profile\n\n- The user goes by Bob",
        memoryMap: "# Memory map\n\n- routing snapshot v1",
      });
      await persistStartupDocsFromPromptBuild();
      appendBigConversation();
      const docsBefore = loadStartupDocs();
      recordPendingInboxRow();
      const pendingRow = context.store.dreamInboxStore.listUnprocessed()[0]!;

      // A clean pass that actually consumes the row (markProcessed, then a
      // final message). The watermark only advances through rows the pass
      // consumed — a completed pass that marked nothing no longer advances.
      completeSimpleMock.mockResolvedValueOnce({
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "Dream",
            arguments: { action: "markProcessed", ids: [pendingRow.id] },
          },
        ],
        stopReason: "toolUse",
      });
      completeSimpleMock.mockResolvedValueOnce({
        content: [{ type: "text", text: "Folded 1 rollout." }],
        stopReason: "stop",
      });
      const result = await awaitPreCompactionConsolidation({
        stellaDataDir: context.stellaDataDir,
        store: context.store,
        resolvedLlm: createRoute(),
      });
      expect(result.outcome).toBe("consolidated");
      const watermark =
        context.store.dreamInboxStore.readConsolidationWatermark();
      expect(watermark).not.toBeNull();
      expect(watermark!.frontier).toBe(pendingRow.sourceUpdatedAt);

      // Simulate Dream having rewritten the map on disk mid-epoch: the
      // pinned copy stays byte-identical and prompt builds inject nothing.
      writeMemoryDocs({ memoryMap: "# Memory map\n\n- routing snapshot v2" });
      expect(
        await buildStartupPromptMessages({
          context: buildContextFromStore(),
          stellaDataDir: context.stellaDataDir,
        }),
      ).toEqual([]);
      expect(loadStartupDocs()).toEqual(docsBefore);

      // A second boundary with the same pending rows skips the await: the
      // persisted watermark already covers the frontier.
      const second = await awaitPreCompactionConsolidation({
        stellaDataDir: context.stellaDataDir,
        store: context.store,
        resolvedLlm: createRoute(),
      });
      expect(second.outcome).toBe("skipped_fresh");

      // Only the compaction boundary lets the disk state in.
      await compactOnce();
      const mapDoc = loadStartupDocs().find((doc) =>
        doc.text.includes(LIFE_MEMORY_MAP_DISPLAY_PATH),
      );
      expect(mapDoc?.text).toContain("routing snapshot v2");
    });
  });
});
