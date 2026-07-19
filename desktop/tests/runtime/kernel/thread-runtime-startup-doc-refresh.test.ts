import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compaction-boundary refresh of pinned resident startup docs, exercised
// against the real SQLite store: mid-epoch the persisted doc copies must stay
// byte-frozen no matter how the source files change (prompt-cache stability),
// and a successful compaction must rewrite them in place from disk (same
// entry, same position) so the new epoch starts current.

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
  LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  refreshResidentStartupDocs,
} from "../../../../runtime/kernel/memory/resident-docs.js";
import {
  readMemorySummaryDoc,
  readUserProfileDoc,
} from "../../../../runtime/kernel/runner/shared.js";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";

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

const writeMemoryDocs = (args: { profile: string; summary: string }): void => {
  const memoriesDir = path.join(context.stellaDataDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  fs.writeFileSync(path.join(memoriesDir, "profile.md"), args.profile);
  fs.writeFileSync(path.join(memoriesDir, "memory_summary.md"), args.summary);
};

const buildContextFromStore = () => ({
  systemPrompt: "system",
  dynamicContext: "",
  maxAgentDepth: 1,
  threadHistory: context.store.loadThreadMessages(THREAD_KEY),
  userProfile: readUserProfileDoc(context.stellaDataDir),
  memorySummary: readMemorySummaryDoc(context.stellaDataDir),
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
      summary: "# Memory summary\n\n- focus snapshot v1",
    });
    expect(await persistStartupDocsFromPromptBuild()).toBe(2);
    const docsBefore = loadStartupDocs();
    expect(docsBefore).toHaveLength(2);

    appendBigConversation();

    // Mid-epoch rewrite: Remember updates the profile; Dream rewrites the
    // summary. Prompt builds must inject nothing (byte-stable prefix) and the
    // persisted copies must stay byte-identical.
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Robert",
      summary: "# Memory summary\n\n- focus snapshot v2",
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
    const summaryDoc = docsAfter.find((doc) =>
      doc.text.includes(LIFE_MEMORY_SUMMARY_DISPLAY_PATH),
    );
    expect(summaryDoc?.text).toContain("focus snapshot v2");

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
      summary: "# Memory summary\n\n- focus snapshot v1",
    });
    await persistStartupDocsFromPromptBuild();
    const docsBefore = loadStartupDocs();

    // Delete the summary source; refresh must keep the existing pinned copy
    // rather than blanking resident context, and must not touch the
    // unchanged profile doc at all.
    fs.rmSync(
      path.join(context.stellaDataDir, "memories", "memory_summary.md"),
    );
    const refreshed = refreshResidentStartupDocs({
      store: context.store,
      threadKey: THREAD_KEY,
      stellaDataDir: context.stellaDataDir,
    });
    expect(refreshed).toBe(0);
    expect(loadStartupDocs()).toEqual(docsBefore);
  });

  it("scrubs a legacy persisted copy containing a retired comment at the boundary", () => {
    // Copies persisted before comment-stripping landed still carry the
    // graveyard; the first boundary refresh rewrites them from the (now
    // stripped) disk read even when the file itself did not change.
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Bob",
      summary:
        "# Memory summary\n\n- focus snapshot v1\n<!-- DREAM:RETIRED_SUMMARY\n- retired bullet\n-->",
    });
    persistThreadCustomMessage(context.store, {
      threadKey: THREAD_KEY,
      customType: "bootstrap.startup_doc",
      content: [
        {
          type: "text",
          text: buildStartupDocMessage(
            LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
            "# Memory summary\n\n- focus snapshot v1\n<!-- DREAM:RETIRED_SUMMARY\n- retired bullet\n-->",
          ),
        },
      ],
      display: false,
    });

    const refreshed = refreshResidentStartupDocs({
      store: context.store,
      threadKey: THREAD_KEY,
      stellaDataDir: context.stellaDataDir,
    });
    expect(refreshed).toBe(1);
    const [doc] = loadStartupDocs();
    expect(doc!.text).toContain("focus snapshot v1");
    expect(doc!.text).not.toContain("retired bullet");
    expect(doc!.text).not.toContain("DREAM:RETIRED_SUMMARY");
  });

  it("updateThreadCustomMessageContent rejects unknown entries and preserves metadata", () => {
    writeMemoryDocs({
      profile: "# User Profile\n\n- The user goes by Bob",
      summary: "# Memory summary\n\n- focus snapshot v1",
    });
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
});
