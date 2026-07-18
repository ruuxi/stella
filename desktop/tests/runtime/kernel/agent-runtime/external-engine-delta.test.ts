import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildClaudeCodeTurnPrompts,
  buildExternalThreadUpdatesDelta,
  getExternalDeliveredEntryId,
  setExternalDeliveredEntryId,
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
      // A lost resume or compaction loop substitutes the fallback prompt for
      // the one the watermark was computed from, so the fallback must carry
      // the delta too — otherwise the report would be watermarked as
      // delivered without ever reaching the reseeded session.
      expect(resumeFallbackPrompt).toContain("<stella_thread_history");
      expect(resumeFallbackPrompt).toContain("stella_thread_updates");
      expect(resumeFallbackPrompt).toContain("MIGRATION-RESULT-ALPHA");

      // Turn succeeded: watermark advances; second resume must not re-send.
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: delta.lastEntryId!,
      });
      const second = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
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
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: firstEntryId,
      });
      const secondEntryId = appendChildReport(
        store,
        threadKey,
        2_001,
        "[Agent report] child-b completed: RESULT-TWO",
      );

      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
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

  it("session-creating turn: rows covered by the history snapshot ride in it alone, without a duplicate delta", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-6";
      appendChildReport(
        store,
        threadKey,
        7_000,
        "[Agent report] child-a completed: SEED-ROW",
      );
      const historyPromptMessage = {
        messageType: "message" as const,
        uiVisibility: "hidden" as const,
        customType: "runtime.stella_thread_history",
        text: '<stella_thread_history source="stella">\n<history_message index="1" role="runtimeInternal">\n[Agent report] child-a completed: SEED-ROW\n</history_message>\n</stella_thread_history>',
      };
      // Call-site contract: no persisted session -> the delta is deduped
      // against the history block sent in the same prompt, so a snapshot-
      // covered row is not injected twice, but the watermark still advances.
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        deliveredContextTexts: [historyPromptMessage.text],
      });
      expect(delta.message).toBeNull();
      expect(delta.lastEntryId).toBeTruthy();
      const { prompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        hasPersistedSession: false,
        deltaPromptMessage: delta.message,
      });
      expect(prompt).toContain("<stella_thread_history");
      expect(prompt).not.toContain("stella_thread_updates");
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: delta.lastEntryId!,
      });
      const resumed = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
        promptMessages: [{ text: "Continue." }],
      });
      expect(resumed.message).toBeNull();
    }));

  it("session-creating turn: a report landing after the history snapshot is still in the sent prompt before it is watermarked", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-9";
      appendChildReport(
        store,
        threadKey,
        9_000,
        "[Agent report] child-a completed: EARLY-ROW",
      );
      // The run's history snapshot is taken now (context construction)...
      const historyPromptMessage = {
        messageType: "message" as const,
        uiVisibility: "hidden" as const,
        customType: "runtime.stella_thread_history",
        text: '<stella_thread_history source="stella">\n<history_message index="1" role="runtimeInternal">\n[Agent report] child-a completed: EARLY-ROW\n</history_message>\n</stella_thread_history>',
      };
      // ...and a second child completes during the async window before the
      // engine turn starts. It is absent from the snapshot.
      const lateEntryId = appendChildReport(
        store,
        threadKey,
        9_001,
        "[Agent report] child-b completed: LATE-ROW",
      );

      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        deliveredContextTexts: [historyPromptMessage.text],
      });
      // Only the late row needs the delta; the early row rides in history.
      expect(delta.message?.text).toContain("LATE-ROW");
      expect(delta.message?.text).not.toContain("EARLY-ROW");
      expect(delta.lastEntryId).toBe(lateEntryId);

      const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        hasPersistedSession: false,
        deltaPromptMessage: delta.message,
      });
      // Reviewer probe: the watermark (lastEntryId = late row) may only
      // advance because the late row is verifiably IN the prompt sent —
      // including the fallback used by reseed recovery.
      expect(prompt).toContain("LATE-ROW");
      expect(resumeFallbackPrompt).toContain("LATE-ROW");
      expect(prompt.split("EARLY-ROW")).toHaveLength(2);
    }));

  it("still delivers an undelivered report that compaction folded into a checkpoint", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-7";
      store.appendThreadMessage({
        threadKey,
        timestamp: 8_000,
        role: "user",
        content: "Old request",
        payload: { role: "user", content: "Old request", timestamp: 8_000 },
      });
      const deliveredEntryId = appendChildReport(
        store,
        threadKey,
        8_001,
        "[Agent report] child-a completed: ALREADY-SENT-ROW",
      );
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: deliveredEntryId,
      });
      // Reviewer shape: the next report is NOT delivered yet when compaction
      // folds it (with everything before it) into one summary row...
      const foldedUndeliveredEntryId = appendChildReport(
        store,
        threadKey,
        8_002,
        "[Agent report] child-b completed: FOLDED-UNDELIVERED-ROW",
      );
      store.compactThread({
        threadKey,
        summary: "Condensed earlier coordination",
        fromEntryId: store.loadThreadMessages(threadKey)[0]!.entryId!,
        toEntryId: foldedUndeliveredEntryId,
        tokensBefore: 999,
        timestamp: 8_100,
      });
      // ...and a newer report survives past the checkpoint.
      const survivingEntryId = appendChildReport(
        store,
        threadKey,
        8_200,
        "[Agent report] child-c completed: SURVIVING-ROW",
      );
      // Prove the shape: the projection no longer carries the folded row.
      const projected = store.loadThreadMessagesWithEntryTypes(threadKey);
      expect(
        projected.some((row) => row.content.includes("FOLDED-UNDELIVERED-ROW")),
      ).toBe(false);

      // The delta scans raw entries, so the folded-but-undelivered report is
      // still a candidate and the watermark cannot silently jump past it.
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
        promptMessages: [{ text: "Continue." }],
      });
      expect(delta.message?.text).toContain("FOLDED-UNDELIVERED-ROW");
      expect(delta.message?.text).toContain("SURVIVING-ROW");
      expect(delta.message?.text).not.toContain("ALREADY-SENT-ROW");
      expect(delta.lastEntryId).toBe(survivingEntryId);
    }));

  it("scopes the watermark per engine so a Claude→Codex takeover re-delivers what Codex never saw", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-8";
      const reportEntryId = appendChildReport(
        store,
        threadKey,
        10_000,
        "[Agent report] child-a completed: CLAUDE-ERA-RESULT",
      );
      // Delivered to the Claude transcript only.
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: reportEntryId,
      });
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBe(reportEntryId);
      // Reviewer probe: Codex gets no full-history reseed on takeover, so it
      // must not inherit Claude's watermark — its first turn delivers the
      // Claude-era report through the delta.
      const codexWatermark = getExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "codex_cli",
      });
      expect(codexWatermark).toBeUndefined();
      const codexDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        ...(codexWatermark ? { afterEntryId: codexWatermark } : {}),
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(codexDelta.message?.text).toContain("CLAUDE-ERA-RESULT");
      // After the Codex turn succeeds, each engine keeps its own scope.
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "codex_cli",
        entryId: codexDelta.lastEntryId!,
      });
      expect(
        getExternalDeliveredEntryId({ store, threadKey, engine: "codex_cli" }),
      ).toBe(reportEntryId);
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBeUndefined();
    }));

  it("treats a legacy un-namespaced watermark as unseen for every engine", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-10";
      // Written before engine namespacing existed. Attributing it to either
      // engine could skip rows the other never saw; reading it as undefined
      // only re-delivers (at-least-once), which is the safe failure mode.
      store.setThreadExternalDeliveredEntryId(threadKey, "legacy-entry-1");
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBeUndefined();
      expect(
        getExternalDeliveredEntryId({ store, threadKey, engine: "codex_cli" }),
      ).toBeUndefined();
    }));

  it("round-trips the delivered watermark through the store", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-11";
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: "entry-123",
      });
      expect(store.getThreadExternalDeliveredEntryId(threadKey)).toBe(
        "claude_code_local:entry-123",
      );
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBe("entry-123");
      store.setThreadExternalDeliveredEntryId(threadKey, null);
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
    }));

  it("adds the watermark column to a legacy database missing it", () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-external-delta-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5000,
    }) as unknown as SqliteDatabase;
    try {
      // Simulate a database created before external_delivered_entry_id (the
      // pre-watermark runtime_threads shape, external_session_id included).
      db.exec(`
        CREATE TABLE runtime_threads (
          thread_key TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          summary TEXT,
          external_session_id TEXT,
          group_key TEXT,
          group_label TEXT
        );
      `);
      db.exec(`
        INSERT INTO runtime_threads (
          thread_key, conversation_id, agent_type, name, status,
          created_at, last_used_at, external_session_id
        ) VALUES (
          'conversation-1:manager:thread-legacy', 'conversation-1', 'manager',
          'Legacy thread', 'active', 1, 1, 'claude_code_local:legacy-session'
        );
      `);
      initializeDesktopDatabase(db);
      const store = new SessionStore(db);
      const threadKey = "conversation-1:manager:thread-legacy";
      // Existing data survives the migration...
      expect(store.getThreadExternalSessionId(threadKey)).toBe(
        "claude_code_local:legacy-session",
      );
      // ...and the migrated column starts empty and round-trips.
      expect(
        store.getThreadExternalDeliveredEntryId(threadKey),
      ).toBeUndefined();
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "claude_code_local",
        entryId: "entry-legacy-1",
      });
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBe("entry-legacy-1");
    } finally {
      (db as unknown as { close: () => void }).close();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
