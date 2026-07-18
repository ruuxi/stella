import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildClaudeCodeTurnPrompts,
  buildExternalThreadUpdatesDelta,
} from "../../../../../runtime/kernel/agent-runtime/external-engines.js";
import { buildCodexPromptFromMessages } from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const MANAGER_WAKE_STUB =
  "Review the newly persisted managed-child event in this thread and continue the instructed process.";

const withStore = (
  work: (store: SessionStore) => void | Promise<void>,
): Promise<void> | void => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-external-delta-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  try {
    initializeDesktopDatabase(db);
    return work(new SessionStore(db));
  } finally {
    (db as unknown as { close: () => void }).close();
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
};

const appendChildReport = (
  store: SessionStore,
  threadKey: string,
  timestamp: number,
  text: string,
): string => {
  store.appendThreadCustomMessage({
    threadKey,
    timestamp,
    customType: "runtime.task_lifecycle",
    content: [{ type: "text", text }],
    display: false,
  });
  const rows = store.loadThreadMessagesWithEntryTypes(threadKey);
  const entryId = rows[rows.length - 1]?.entryId;
  if (!entryId) throw new Error("expected appended custom row entry id");
  return entryId;
};

describe("external-engine out-of-band delta injection", () => {
  it("delivers a persisted child report to a resumed claude-code manager turn exactly once", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-1";
      store.appendThreadMessage({
        threadKey,
        timestamp: 1_000,
        role: "user",
        content: "Coordinate the migration",
        payload: {
          role: "user",
          content: "Coordinate the migration",
          timestamp: 1_000,
        },
      });
      store.appendThreadMessage({
        threadKey,
        timestamp: 1_001,
        role: "assistant",
        content: "Spawning children now.",
      });
      appendChildReport(
        store,
        threadKey,
        1_002,
        "[Agent report] child-a completed: MIGRATION-RESULT-ALPHA",
      );

      // First resumed turn: no watermark yet — the report must be injected.
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message).not.toBeNull();
      expect(delta.message?.uiVisibility).toBe("hidden");
      expect(delta.message?.customType).toBe("runtime.stella_thread_updates");
      expect(delta.message?.text).toContain("MIGRATION-RESULT-ALPHA");
      expect(delta.lastEntryId).toBeTruthy();

      const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage: {
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.stella_thread_history",
          text: '<stella_thread_history source="stella">\n<history_message index="1" role="user">\nCoordinate the migration\n</history_message>\n</stella_thread_history>',
        },
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        hasPersistedSession: true,
        deltaPromptMessage: delta.message,
      });
      // The resumed prompt gets the delta but never the quadratic full block.
      expect(prompt).toContain("MIGRATION-RESULT-ALPHA");
      expect(prompt).toContain(MANAGER_WAKE_STUB);
      expect(prompt).not.toContain("<stella_thread_history");
      // A reseed replays the full history instead; no duplicate delta there.
      expect(resumeFallbackPrompt).toContain("<stella_thread_history");
      expect(resumeFallbackPrompt).not.toContain("stella_thread_updates");

      // Turn succeeded: watermark advances; second resume must not re-send.
      store.setThreadExternalDeliveredEntryId(threadKey, delta.lastEntryId);
      const second = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: store.getThreadExternalDeliveredEntryId(threadKey),
        promptMessages: [{ text: "Continue." }],
      });
      expect(second.message).toBeNull();
      expect(second.lastEntryId).toBe(delta.lastEntryId);
      const { prompt: secondPrompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage: null,
        promptMessages: [{ text: "Continue." }],
        hasPersistedSession: true,
        deltaPromptMessage: second.message,
      });
      expect(secondPrompt).not.toContain("MIGRATION-RESULT-ALPHA");
    }));

  it("delivers only rows persisted after the watermark on later resumes", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-2";
      const firstEntryId = appendChildReport(
        store,
        threadKey,
        2_000,
        "[Agent report] child-a completed: RESULT-ONE",
      );
      store.setThreadExternalDeliveredEntryId(threadKey, firstEntryId);
      const secondEntryId = appendChildReport(
        store,
        threadKey,
        2_001,
        "[Agent report] child-b completed: RESULT-TWO",
      );

      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: store.getThreadExternalDeliveredEntryId(threadKey),
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message?.text).toContain("RESULT-TWO");
      expect(delta.message?.text).not.toContain("RESULT-ONE");
      expect(delta.lastEntryId).toBe(secondEntryId);
    }));

  it("mirrors the injection into the codex prompt", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-3";
      appendChildReport(
        store,
        threadKey,
        3_000,
        "[Agent report] child-a completed: CODEX-RESULT",
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message).not.toBeNull();
      const prompt = buildCodexPromptFromMessages({
        promptMessages: [delta.message!, { text: MANAGER_WAKE_STUB }],
      });
      expect(prompt).toContain("CODEX-RESULT");
      expect(prompt).toContain(MANAGER_WAKE_STUB);
    }));

  it("advances the in-turn cursor so a queued rebuild only carries mid-turn rows", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-4";
      appendChildReport(
        store,
        threadKey,
        4_000,
        "[Agent report] child-a completed: MAIN-TURN-ROW",
      );
      const mainDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(mainDelta.message?.text).toContain("MAIN-TURN-ROW");

      // A second child finishes while the engine turn is still running.
      const midTurnEntryId = appendChildReport(
        store,
        threadKey,
        4_001,
        "[Agent report] child-b completed: MID-TURN-ROW",
      );
      const queuedDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: mainDelta.lastEntryId ?? undefined,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(queuedDelta.message?.text).toContain("MID-TURN-ROW");
      expect(queuedDelta.message?.text).not.toContain("MAIN-TURN-ROW");
      expect(queuedDelta.lastEntryId).toBe(midTurnEntryId);
    }));

  it("counts rows already present in this turn's prompt as delivered without re-injecting them", () =>
    withStore((store) => {
      const threadKey = "conversation-1:orchestrator";
      const reportText = "[Agent report] child-a completed: FOLLOWUP-DELIVERED";
      const entryId = appendChildReport(store, threadKey, 5_000, reportText);

      // The orchestrator's in-memory follow-up already carries the report
      // verbatim; the delta must not duplicate it but must still advance.
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: reportText }],
      });
      expect(delta.message).toBeNull();
      expect(delta.lastEntryId).toBe(entryId);
    }));

  it("ignores engine-authored rows and non-lifecycle custom rows", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-5";
      store.appendThreadMessage({
        threadKey,
        timestamp: 6_000,
        role: "assistant",
        content: "Engine-authored reply",
      });
      store.appendThreadCustomMessage({
        threadKey,
        timestamp: 6_001,
        customType: "bootstrap.startup_doc",
        content: [{ type: "text", text: "startup doc body" }],
        display: false,
      });
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: "Continue." }],
      });
      expect(delta.message).toBeNull();
      expect(delta.lastEntryId).toBeNull();
    }));

  it("keeps session-creating turns on the full history block without a duplicate delta", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-6";
      appendChildReport(
        store,
        threadKey,
        7_000,
        "[Agent report] child-a completed: SEED-ROW",
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      // Call-site contract: no persisted session -> full history is sent and
      // the delta message is withheld (`deltaPromptMessage: null`), while the
      // watermark still advances past the seeded rows.
      const { prompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage: {
          messageType: "message",
          uiVisibility: "hidden",
          customType: "runtime.stella_thread_history",
          text: '<stella_thread_history source="stella">\n<history_message index="1" role="runtimeInternal">\n[Agent report] child-a completed: SEED-ROW\n</history_message>\n</stella_thread_history>',
        },
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        hasPersistedSession: false,
        deltaPromptMessage: null,
      });
      expect(prompt).toContain("<stella_thread_history");
      expect(prompt).not.toContain("stella_thread_updates");
      store.setThreadExternalDeliveredEntryId(threadKey, delta.lastEntryId);
      const resumed = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: store.getThreadExternalDeliveredEntryId(threadKey),
        promptMessages: [{ text: "Continue." }],
      });
      expect(resumed.message).toBeNull();
    }));

  it("re-delivers surviving rows when the watermark entry was folded into a compaction checkpoint", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-7";
      store.appendThreadMessage({
        threadKey,
        timestamp: 8_000,
        role: "user",
        content: "Old request",
        payload: { role: "user", content: "Old request", timestamp: 8_000 },
      });
      const oldReportEntryId = appendChildReport(
        store,
        threadKey,
        8_001,
        "[Agent report] child-a completed: OLD-ROW",
      );
      store.setThreadExternalDeliveredEntryId(threadKey, oldReportEntryId);
      const newReportEntryId = appendChildReport(
        store,
        threadKey,
        8_002,
        "[Agent report] child-b completed: SURVIVING-ROW",
      );
      // Compaction folds everything up to (and including) the watermark row.
      store.compactThread({
        threadKey,
        summary: "Condensed earlier coordination",
        fromEntryId: store.loadThreadMessages(threadKey)[0]!.entryId!,
        toEntryId: oldReportEntryId,
        tokensBefore: 999,
        timestamp: 8_100,
      });

      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: store.getThreadExternalDeliveredEntryId(threadKey),
        promptMessages: [{ text: "Continue." }],
      });
      // The watermark no longer resolves, so every surviving out-of-band row
      // (all newer than the folded watermark) is delivered.
      expect(delta.message?.text).toContain("SURVIVING-ROW");
      expect(delta.message?.text).not.toContain("OLD-ROW");
      expect(delta.lastEntryId).toBe(newReportEntryId);
    }));

  it("round-trips the delivered watermark through the store", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-8";
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
      store.setThreadExternalDeliveredEntryId(threadKey, "entry-123");
      expect(store.getThreadExternalDeliveredEntryId(threadKey)).toBe(
        "entry-123",
      );
      store.setThreadExternalDeliveredEntryId(threadKey, null);
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
    }));
});
