import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildClaudeCodeTurnPrompts,
  buildExternalThreadUpdatesDelta,
  createExternalDeltaWatermarkTracker,
  EXTERNAL_DELTA_MAX_MESSAGE_CHARS,
  EXTERNAL_DELTA_MAX_ROWS,
  EXTERNAL_DELTA_MAX_TOTAL_CHARS,
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

  it("queued follow-up + recovery reseed: a row consumed by the in-turn cursor still reaches the reseeded session before the watermark passes it", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-12";
      // History snapshot frozen at context construction — WITHOUT row R.
      const historyPromptMessage = {
        messageType: "message" as const,
        uiVisibility: "hidden" as const,
        customType: "runtime.stella_thread_history",
        text: '<stella_thread_history source="stella">\n<history_message index="1" role="user">\nCoordinate the work\n</history_message>\n</stella_thread_history>',
      };
      // R lands after the snapshot; the resumed main prompt delivers it.
      const rowREntryId = appendChildReport(
        store,
        threadKey,
        12_000,
        "[Agent report] child-a completed: ROW-R-RESULT",
      );
      const tracker = createExternalDeltaWatermarkTracker(undefined);
      const mainDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(mainDelta.message?.text).toContain("ROW-R-RESULT");
      tracker.noteMainlineDelta(mainDelta);
      expect(tracker.cursor).toBe(rowREntryId);

      // Queued follow-up: the cursor-anchored delta rightly excludes R...
      const queuedDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: tracker.cursor,
        promptMessages: [{ text: "Queued follow-up." }],
      });
      expect(queuedDelta.message).toBeNull();
      // ...but the queued FALLBACK is anchored at the persisted watermark:
      // a reseed abandons the session that received R with the main prompt.
      const queuedFallbackDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: "Queued follow-up." }],
        deliveredContextTexts: [historyPromptMessage.text],
      });
      expect(queuedFallbackDelta.message?.text).toContain("ROW-R-RESULT");
      tracker.noteMainlineDelta(queuedDelta);
      tracker.noteReseedDelta(queuedFallbackDelta);

      const { prompt: queuedPrompt, resumeFallbackPrompt } =
        buildClaudeCodeTurnPrompts({
          historyPromptMessage,
          promptMessages: [{ text: "Queued follow-up." }],
          hasPersistedSession: true,
          deltaPromptMessage: queuedDelta.message,
          fallbackDeltaPromptMessage: queuedFallbackDelta.message,
        });
      // Live session already has R; a reseeded session gets it via fallback.
      expect(queuedPrompt).not.toContain("ROW-R-RESULT");
      expect(resumeFallbackPrompt).toContain("ROW-R-RESULT");
      // Fallback covered R, so the watermark may legitimately pass it.
      expect(tracker.resolve()).toBe(rowREntryId);
    }));

  it("queued reseed fallback exists even when the history snapshot is empty", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-13";
      appendChildReport(
        store,
        threadKey,
        13_000,
        "[Agent report] child-a completed: FIRST-EVER-ROW",
      );
      const fallbackDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: "Queued follow-up." }],
      });
      // Brand-new manager thread: no history snapshot, but the queued
      // fallback must still reseed the row the main prompt consumed.
      const { resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage: null,
        promptMessages: [{ text: "Queued follow-up." }],
        hasPersistedSession: true,
        deltaPromptMessage: null,
        fallbackDeltaPromptMessage: fallbackDelta.message,
      });
      expect(resumeFallbackPrompt).toContain("FIRST-EVER-ROW");
    }));

  it("watermark tracker: a truncated reseed fallback pins the watermark below the in-turn cursor", () => {
    const tracker = createExternalDeltaWatermarkTracker("entry-0");
    tracker.noteMainlineDelta({
      message: null,
      lastEntryId: "entry-3",
      coveredCount: 3,
      truncated: false,
    });
    // The reseed prompt only covered one row before hitting the budget: if
    // recovery used it, the fresh session never saw entries 2-3.
    tracker.noteReseedDelta({
      message: null,
      lastEntryId: "entry-1",
      coveredCount: 1,
      truncated: true,
    });
    expect(tracker.resolve()).toBe("entry-1");

    // Full-coverage fallback keeps the cursor.
    const covered = createExternalDeltaWatermarkTracker("entry-0");
    covered.noteMainlineDelta({
      message: null,
      lastEntryId: "entry-3",
      coveredCount: 3,
      truncated: false,
    });
    covered.noteReseedDelta({
      message: null,
      lastEntryId: "entry-3",
      coveredCount: 3,
      truncated: false,
    });
    expect(covered.resolve()).toBe("entry-3");

    // No deltas at all resolves to the unchanged initial watermark.
    expect(createExternalDeltaWatermarkTracker("entry-0").resolve()).toBe(
      "entry-0",
    );
  });

  it("bounds an oversized backlog, always includes the triggering row, and drains in order across turns", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-14";
      const bigReport = (marker: string) =>
        `[Agent report] ${marker} ${"x".repeat(20_000)} TAIL-${marker}-END`;
      appendChildReport(store, threadKey, 14_000, bigReport("BACKLOG-A"));
      const entryB = appendChildReport(
        store,
        threadKey,
        14_001,
        bigReport("BACKLOG-B"),
      );
      appendChildReport(store, threadKey, 14_002, bigReport("BACKLOG-C"));
      const entryD = appendChildReport(
        store,
        threadKey,
        14_003,
        bigReport("BACKLOG-D"),
      );

      // No watermark (legacy value or engine takeover): the first batch is
      // bounded instead of replaying the whole raw backlog into one prompt.
      const first = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      // Contiguous prefix: A and B, whole (tails intact — the tail carries
      // outcomes/blockers and must never be cut).
      expect(first.message?.text).toContain("BACKLOG-A");
      expect(first.message?.text).toContain("TAIL-BACKLOG-A-END");
      expect(first.message?.text).toContain("TAIL-BACKLOG-B-END");
      // C is withheld — but D, the newest row (the one whose persistence
      // triggered this wake), is ALWAYS present, whole, as a marked
      // out-of-order section.
      expect(first.message?.text).not.toContain("BACKLOG-C");
      expect(first.message?.text).toContain("TAIL-BACKLOG-D-END");
      expect(first.message?.text).toContain(
        "Newest update, delivered ahead of the withheld ones",
      );
      // Withheld rows are NEWER than the packed prefix; the marker says so.
      expect(first.message?.text).toContain("NEWER updates were withheld");
      expect(first.message?.text).not.toContain("older updates were withheld");
      expect(first.truncated).toBe(true);
      // The watermark advances only through the contiguous prefix (A, B) —
      // never through the out-of-order D section.
      expect(first.coveredCount).toBe(2);
      expect(first.lastEntryId).toBe(entryB);

      // Next turn: C and D delivered in order — D is re-delivered
      // (at-least-once, the safe direction).
      setExternalDeliveredEntryId({
        store,
        threadKey,
        engine: "codex_cli",
        entryId: first.lastEntryId!,
      });
      const second = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        afterEntryId: getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "codex_cli",
        }),
        promptMessages: [{ text: "Continue." }],
      });
      expect(second.message?.text).toContain("TAIL-BACKLOG-C-END");
      expect(second.message?.text).toContain("TAIL-BACKLOG-D-END");
      expect(second.message?.text).not.toContain("BACKLOG-B");
      expect(second.truncated).toBe(false);
      expect(second.lastEntryId).toBe(entryD);
    }));

  it("gives a report larger than the block budget its own dedicated batch, tail intact", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-15";
      appendChildReport(
        store,
        threadKey,
        15_000,
        `[Agent report] HUGE-REPORT ${"y".repeat(EXTERNAL_DELTA_MAX_TOTAL_CHARS + 12_000)} HUGE-TAIL-END`,
      );
      const smallEntryId = appendChildReport(
        store,
        threadKey,
        15_001,
        "[Agent report] child-b completed: SMALL-AFTER-HUGE",
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      // Delivered WHOLE as a one-report batch: no tail cut, no elision.
      expect(delta.message?.text).toContain("HUGE-REPORT");
      expect(delta.message?.text).toContain("HUGE-TAIL-END");
      expect(delta.message?.text).not.toContain("elided");
      // The small newer row is the triggering row: present out-of-order.
      expect(delta.message?.text).toContain("SMALL-AFTER-HUGE");
      // Watermark covers only the dedicated report, not the newer row.
      expect(delta.coveredCount).toBe(1);
      expect(delta.truncated).toBe(true);
      expect(delta.lastEntryId).not.toBe(smallEntryId);
    }));

  it("elides only the middle, never the tail, for a report beyond engine capacity", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-17";
      appendChildReport(
        store,
        threadKey,
        17_000,
        `HEAD-START ${"z".repeat(EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 10_000)} GIANT-TAIL-END`,
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message?.text).toContain("HEAD-START");
      expect(delta.message?.text).toContain("GIANT-TAIL-END");
      expect(delta.message?.text).toContain(
        "elided from the MIDDLE of this report",
      );
      expect(delta.coveredCount).toBe(1);
      // The COMPLETE serialized message honors the global cap.
      expect(delta.message!.text.length).toBeLessThanOrEqual(
        EXTERNAL_DELTA_MAX_MESSAGE_CHARS,
      );
    }));

  it("caps the complete serialized message when a bounded prefix meets an oversized triggering row", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-20";
      // Reviewer probe: ~45k of prefix + >300k newest previously composed
      // to ~345k because the latest section was elided independently.
      appendChildReport(
        store,
        threadKey,
        20_000,
        `[Agent report] PREFIX-A ${"a".repeat(20_000)} TAIL-PREFIX-A-END`,
      );
      appendChildReport(
        store,
        threadKey,
        20_001,
        `[Agent report] PREFIX-B ${"b".repeat(20_000)} TAIL-PREFIX-B-END`,
      );
      appendChildReport(
        store,
        threadKey,
        20_002,
        `[Agent report] SKIPPED-C ${"c".repeat(10_000)}`,
      );
      appendChildReport(
        store,
        threadKey,
        20_003,
        `TRIGGER-HEAD ${"t".repeat(EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 20_000)} TRIGGER-TAIL-END`,
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message!.text.length).toBeLessThanOrEqual(
        EXTERNAL_DELTA_MAX_MESSAGE_CHARS,
      );
      // Prefix rows stay whole; the oversized trigger keeps head AND tail.
      expect(delta.message?.text).toContain("TAIL-PREFIX-A-END");
      expect(delta.message?.text).toContain("TAIL-PREFIX-B-END");
      expect(delta.message?.text).not.toContain("SKIPPED-C");
      expect(delta.message?.text).toContain("TRIGGER-HEAD");
      expect(delta.message?.text).toContain("TRIGGER-TAIL-END");
      expect(delta.coveredCount).toBe(2);
      expect(delta.truncated).toBe(true);
    }));

  it("caps the complete serialized message when a dedicated oversized report meets an oversized triggering row", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-21";
      // Reviewer probe: both independently elided to ~300k previously
      // composed to ~601k. Now they share the cap roughly in half.
      appendChildReport(
        store,
        threadKey,
        21_000,
        `DEDICATED-HEAD ${"d".repeat(EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 20_000)} DEDICATED-TAIL-END`,
      );
      appendChildReport(
        store,
        threadKey,
        21_001,
        `TRIGGER-HEAD ${"t".repeat(EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 20_000)} TRIGGER-TAIL-END`,
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message!.text.length).toBeLessThanOrEqual(
        EXTERNAL_DELTA_MAX_MESSAGE_CHARS,
      );
      // Both reports keep head AND tail; both are middle-elided.
      expect(delta.message?.text).toContain("DEDICATED-HEAD");
      expect(delta.message?.text).toContain("DEDICATED-TAIL-END");
      expect(delta.message?.text).toContain("TRIGGER-HEAD");
      expect(delta.message?.text).toContain("TRIGGER-TAIL-END");
      // Watermark covers only the dedicated (older) report.
      expect(delta.coveredCount).toBe(1);
      expect(delta.truncated).toBe(true);
    }));

  it("keeps even a barely-oversized single report within the global cap (wrapper overhead included)", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-22";
      // Reviewer probe: a 300,001-char row previously serialized to 300,494.
      appendChildReport(
        store,
        threadKey,
        22_000,
        "e".repeat(EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 1),
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      expect(delta.message!.text.length).toBeLessThanOrEqual(
        EXTERNAL_DELTA_MAX_MESSAGE_CHARS,
      );
      expect(delta.coveredCount).toBe(1);
      expect(delta.truncated).toBe(false);
    }));

  it("never splits a surrogate pair at an elision boundary", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-23";
      // A report made of astral-plane pairs: any code-unit boundary inside
      // the body would split a pair unless nudged.
      appendChildReport(
        store,
        threadKey,
        23_000,
        "💀".repeat((EXTERNAL_DELTA_MAX_MESSAGE_CHARS + 40_000) / 2),
      );
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      const text = delta.message!.text;
      expect(text).toContain("elided from the MIDDLE");
      // No lone high surrogate (high not followed by low)...
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
      // ...and no lone low surrogate (low not preceded by high).
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
      expect(text.length).toBeLessThanOrEqual(EXTERNAL_DELTA_MAX_MESSAGE_CHARS);
    }));

  it("bounds the SERIALIZED block (wrappers and envelope included) under a flood of tiny rows", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-18";
      const totalRows = EXTERNAL_DELTA_MAX_ROWS + 150;
      for (let index = 0; index < totalRows; index += 1) {
        appendChildReport(store, threadKey, 18_000 + index, `tick ${index}`);
      }
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
      });
      // Reviewer probe shape: per-row wrapper overhead must not balloon the
      // serialized block past the configured budget.
      expect(delta.message!.text.length).toBeLessThanOrEqual(
        EXTERNAL_DELTA_MAX_TOTAL_CHARS,
      );
      // The row cap bounds the batch; coverage matches exactly what fit.
      expect(delta.coveredCount).toBe(EXTERNAL_DELTA_MAX_ROWS);
      expect(delta.truncated).toBe(true);
      // The triggering (newest) row is still present out-of-order.
      expect(delta.message?.text).toContain(`tick ${totalRows - 1}`);
    }));

  it("dedupes the resumed-turn recovery fallback against its history block so old rows cannot starve new ones", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-19";
      // An old, still-undelivered report big enough to consume the whole
      // packing budget — and already present in the history snapshot.
      const oldReport = `[Agent report] OLD-DUPLICATED-ROW ${"w".repeat(EXTERNAL_DELTA_MAX_TOTAL_CHARS)}`;
      appendChildReport(store, threadKey, 19_000, oldReport);
      const newEntryId = appendChildReport(
        store,
        threadKey,
        19_001,
        "[Agent report] child-b completed: GENUINELY-NEW-ROW",
      );
      const historyPromptMessage = {
        messageType: "message" as const,
        uiVisibility: "hidden" as const,
        customType: "runtime.stella_thread_history",
        text: `<stella_thread_history source="stella">\n<history_message index="1" role="runtimeInternal">\n${oldReport}\n</history_message>\n</stella_thread_history>`,
      };
      // The fallback variant dedupes against the history block it is sent
      // with: the old row is covered for free and the new row fits.
      const fallbackDelta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        deliveredContextTexts: [historyPromptMessage.text],
      });
      expect(fallbackDelta.message?.text).toContain("GENUINELY-NEW-ROW");
      expect(fallbackDelta.message?.text).not.toContain("OLD-DUPLICATED-ROW");
      expect(fallbackDelta.coveredCount).toBe(2);
      expect(fallbackDelta.lastEntryId).toBe(newEntryId);
      expect(fallbackDelta.truncated).toBe(false);

      // Composed fallback prompt: old row once via history, new row via the
      // deduped delta — nothing starved, nothing duplicated.
      const { resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
        historyPromptMessage,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        hasPersistedSession: true,
        deltaPromptMessage: null,
        fallbackDeltaPromptMessage: fallbackDelta.message,
      });
      expect(resumeFallbackPrompt).toContain("GENUINELY-NEW-ROW");
      expect(resumeFallbackPrompt!.split("OLD-DUPLICATED-ROW")).toHaveLength(2);
    }));

  it("legacy takeover with a session-creating turn initializes the watermark from the history block without replaying the backlog", () =>
    withStore((store) => {
      const threadKey = "conversation-1:manager:thread-16";
      const reports = [
        "[Agent report] child-a completed: LEGACY-ROW-1",
        "[Agent report] child-b completed: LEGACY-ROW-2",
        "[Agent report] child-c completed: LEGACY-ROW-3",
      ];
      let newestEntryId = "";
      reports.forEach((text, index) => {
        newestEntryId = appendChildReport(
          store,
          threadKey,
          16_000 + index,
          text,
        );
      });
      // Legacy un-namespaced watermark reads as unseen...
      store.setThreadExternalDeliveredEntryId(threadKey, "legacy-entry");
      expect(
        getExternalDeliveredEntryId({
          store,
          threadKey,
          engine: "claude_code_local",
        }),
      ).toBeUndefined();
      // ...but the takeover turn sends the full-history block, so every row
      // it contains is covered by containment at zero prompt cost: the
      // watermark jumps to the newest covered row with no delta replay.
      const historyText = [
        '<stella_thread_history source="stella">',
        ...reports.map(
          (text, index) =>
            `<history_message index="${index + 1}" role="runtimeInternal">\n${text}\n</history_message>`,
        ),
        "</stella_thread_history>",
      ].join("\n");
      const delta = buildExternalThreadUpdatesDelta({
        store,
        threadKey,
        promptMessages: [{ text: MANAGER_WAKE_STUB }],
        deliveredContextTexts: [historyText],
      });
      expect(delta.message).toBeNull();
      expect(delta.coveredCount).toBe(3);
      expect(delta.lastEntryId).toBe(newestEntryId);
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
