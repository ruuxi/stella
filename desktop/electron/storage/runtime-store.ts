import path from "path";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS,
  RUNTIME_THREAD_NAME_POOL,
  type RuntimeThreadRecord,
  normalizeRuntimeThreadName,
  pickAvailableRuntimeThreadName,
} from "../core/runtime/runtime-threads.js";
import { buildRuntimeThreadKey } from "../core/runtime/thread-runtime.js";
import type { SqliteDatabase } from "./shared.js";
import {
  MAX_RECALL_RESULTS,
  SQLITE_MEMORY_SCAN_LIMIT,
  type RuntimeMemory,
  type RuntimeRunEvent,
  type RuntimeThreadMessage,
  escapeSqlLike,
  fileSafeId,
  parseRuntimeSelfModApplied,
  parseJsonTags,
  scoreMemoryMatches,
  toJsonString,
  toJsonTags,
} from "./shared.js";
import { TranscriptMirror } from "./transcript-mirror.js";

export class RuntimeStore {
  private readonly dirtyRuntimeThreads = new Set<string>();
  private readonly dirtyRuntimeRuns = new Set<string>();
  private dirtyRuntimeMemories = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly mirror: TranscriptMirror,
  ) {}

  private withTransaction(work: () => void): void {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private sanitizeThreadKey(value: unknown): string {
    const threadKey = typeof value === "string" ? value.trim() : "";
    if (!threadKey) {
      throw new Error("threadKey is required.");
    }
    return threadKey;
  }

  private listAllThreadMessages(threadKey: string): RuntimeThreadMessage[] {
    const rows = this.db.prepare(`
      SELECT timestamp, thread_key AS threadKey, role, content, tool_call_id AS toolCallId
      FROM runtime_thread_messages
      WHERE thread_key = ?
      ORDER BY timestamp ASC, id ASC
    `).all(threadKey) as Array<{
      timestamp: number;
      threadKey: string;
      role: "user" | "assistant";
      content: string;
      toolCallId: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      threadKey: row.threadKey,
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    }));
  }

  private rebuildRuntimeThreadTranscript(threadKey: string): void {
    this.mirror.writeRuntimeThread(threadKey, this.listAllThreadMessages(threadKey));
  }

  appendThreadMessage(message: RuntimeThreadMessage): void {
    const threadKey = this.sanitizeThreadKey(message.threadKey);
    this.db.prepare(`
      INSERT INTO runtime_thread_messages (thread_key, timestamp, role, content, tool_call_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      threadKey,
      message.timestamp,
      message.role,
      message.content,
      message.toolCallId ?? null,
    );
    this.touchThread(threadKey);
    try {
      if (this.dirtyRuntimeThreads.has(threadKey) || !this.mirror.runtimeThreadMirrorExists(threadKey)) {
        this.rebuildRuntimeThreadTranscript(threadKey);
        this.dirtyRuntimeThreads.delete(threadKey);
      } else {
        this.mirror.appendRuntimeThreadMessage(threadKey, { ...message, threadKey });
      }
    } catch {
      this.dirtyRuntimeThreads.add(threadKey);
    }
  }

  loadThreadMessages(
    threadKeyInput: string,
    limit?: number,
  ): Array<{ role: string; content: string; toolCallId?: string }> {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT role, content, tool_call_id AS toolCallId
      FROM (
        SELECT id, timestamp, role, content, tool_call_id
        FROM runtime_thread_messages
        WHERE thread_key = ?
        ORDER BY timestamp DESC, id DESC
        ${normalizedLimit ? "LIMIT ?" : ""}
      ) recent
      ORDER BY timestamp ASC, id ASC
    `;
    const rows = (
      normalizedLimit
        ? this.db.prepare(sql).all(threadKey, normalizedLimit)
        : this.db.prepare(sql).all(threadKey)
    ) as Array<{
      role: string;
      content: string;
      toolCallId: string | null;
    }>;
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    }));
  }

  replaceThreadMessages(threadKeyInput: string, nextMessages: RuntimeThreadMessage[]): void {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM runtime_thread_messages WHERE thread_key = ?").run(threadKey);
      const stmt = this.db.prepare(`
        INSERT INTO runtime_thread_messages (thread_key, timestamp, role, content, tool_call_id)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const message of nextMessages) {
        stmt.run(
          threadKey,
          message.timestamp,
          message.role,
          message.content,
          message.toolCallId ?? null,
        );
      }
    });
    try {
      this.rebuildRuntimeThreadTranscript(threadKey);
      this.dirtyRuntimeThreads.delete(threadKey);
    } catch {
      this.dirtyRuntimeThreads.add(threadKey);
    }
  }

  archiveCurrentThread(threadKeyInput: string): string | null {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    return this.mirror.archiveRuntimeThread(threadKey, this.listAllThreadMessages(threadKey));
  }

  archiveAndReplaceThreadMessages(
    threadKeyInput: string,
    nextMessages: RuntimeThreadMessage[],
  ): string | null {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    const archivedPath = this.archiveCurrentThread(threadKey);
    this.replaceThreadMessages(threadKey, nextMessages);
    return archivedPath;
  }

  private listAllRunEvents(runId: string): RuntimeRunEvent[] {
    const rows = this.db.prepare(`
      SELECT
        timestamp,
        run_id AS runId,
        conversation_id AS conversationId,
        agent_type AS agentType,
        seq,
        event_type AS type,
        chunk,
        tool_call_id AS toolCallId,
        tool_name AS toolName,
        result_preview AS resultPreview,
        error,
        fatal,
        final_text AS finalText,
        self_mod_applied_json AS selfModAppliedJson
      FROM runtime_run_events
      WHERE run_id = ?
      ORDER BY COALESCE(seq, id) ASC, id ASC
    `).all(runId) as Array<{
      timestamp: number;
      runId: string;
      conversationId: string;
      agentType: string;
      seq: number | null;
      type: RuntimeRunEvent["type"];
      chunk: string | null;
      toolCallId: string | null;
      toolName: string | null;
      resultPreview: string | null;
      error: string | null;
      fatal: number | null;
      finalText: string | null;
      selfModAppliedJson: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      runId: row.runId,
      conversationId: row.conversationId,
      agentType: row.agentType,
      ...(row.seq == null ? {} : { seq: row.seq }),
      type: row.type,
      ...(row.chunk ? { chunk: row.chunk } : {}),
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      ...(row.toolName ? { toolName: row.toolName } : {}),
      ...(row.resultPreview ? { resultPreview: row.resultPreview } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.fatal == null ? {} : { fatal: row.fatal === 1 }),
      ...(row.finalText ? { finalText: row.finalText } : {}),
      ...(parseRuntimeSelfModApplied(row.selfModAppliedJson)
        ? { selfModApplied: parseRuntimeSelfModApplied(row.selfModAppliedJson) }
        : {}),
    }));
  }

  private rebuildRuntimeRunTranscript(runId: string): void {
    this.mirror.writeRuntimeRun(runId, this.listAllRunEvents(runId));
  }

  private listAllMemories(): RuntimeMemory[] {
    const rows = this.db.prepare(`
      SELECT timestamp, conversation_id AS conversationId, content, tags_json AS tagsJson
      FROM runtime_memories
      ORDER BY timestamp ASC, id ASC
    `).all() as Array<{
      timestamp: number;
      conversationId: string;
      content: string;
      tagsJson: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      conversationId: row.conversationId,
      content: row.content,
      ...(parseJsonTags(row.tagsJson) ? { tags: parseJsonTags(row.tagsJson) } : {}),
    }));
  }

  private rebuildRuntimeMemoryMirror(): void {
    this.mirror.writeRuntimeMemories(this.listAllMemories());
  }

  recordRunEvent(event: RuntimeRunEvent): void {
    this.db.prepare(`
      INSERT INTO runtime_run_events (
        timestamp,
        run_id,
        conversation_id,
        agent_type,
        seq,
        event_type,
        chunk,
        tool_call_id,
        tool_name,
        result_preview,
        error,
        fatal,
        final_text,
        self_mod_applied_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.timestamp,
      event.runId,
      event.conversationId,
      event.agentType,
      event.seq ?? null,
      event.type,
      event.chunk ?? null,
      event.toolCallId ?? null,
      event.toolName ?? null,
      event.resultPreview ?? null,
      event.error ?? null,
      event.fatal == null ? null : (event.fatal ? 1 : 0),
      event.finalText ?? null,
      toJsonString(event.selfModApplied) ?? null,
    );
    try {
      if (this.dirtyRuntimeRuns.has(event.runId) || !this.mirror.runtimeRunMirrorExists(event.runId)) {
        this.rebuildRuntimeRunTranscript(event.runId);
        this.dirtyRuntimeRuns.delete(event.runId);
      } else {
        this.mirror.appendRuntimeRunEvent(event.runId, event);
      }
    } catch {
      this.dirtyRuntimeRuns.add(event.runId);
    }
  }

  saveMemory(args: { conversationId: string; content: string; tags?: string[] }): void {
    const content = args.content.trim();
    if (!content) return;
    const tags = args.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    const entry: RuntimeMemory = {
      timestamp: Date.now(),
      conversationId: args.conversationId,
      content,
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
    this.db.prepare(`
      INSERT INTO runtime_memories (timestamp, conversation_id, content, tags_json)
      VALUES (?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.conversationId,
      entry.content,
      toJsonTags(entry.tags),
    );
    try {
      if (this.dirtyRuntimeMemories || !this.mirror.runtimeMemoryMirrorExists()) {
        this.rebuildRuntimeMemoryMirror();
        this.dirtyRuntimeMemories = false;
      } else {
        this.mirror.appendRuntimeMemory(entry);
      }
    } catch {
      this.dirtyRuntimeMemories = true;
    }
  }

  recallMemories(args: { query: string; limit?: number }): RuntimeMemory[] {
    const query = args.query.trim().toLowerCase();
    if (!query) return [];
    const limit = Math.max(1, Math.min(MAX_RECALL_RESULTS, args.limit ?? MAX_RECALL_RESULTS));
    const queryTokens = Array.from(new Set(query.split(/\s+/).filter((token) => token.length > 0)));
    const terms = [query, ...queryTokens];
    const whereClauses = terms.map(() => "lower(content || ' ' || coalesce(tags_json, '')) LIKE ? ESCAPE '\\'");
    const params = terms.map((term) => `%${escapeSqlLike(term)}%`);
    const sql = `
      SELECT timestamp, conversation_id AS conversationId, content, tags_json AS tagsJson
      FROM runtime_memories
      ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(" OR ")}` : ""}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(
      ...params,
      SQLITE_MEMORY_SCAN_LIMIT,
    ) as Array<{
      timestamp: number;
      conversationId: string;
      content: string;
      tagsJson: string | null;
    }>;
    if (rows.length === 0) return [];
    const normalizedRows: RuntimeMemory[] = rows.map((row) => ({
      timestamp: row.timestamp,
      conversationId: row.conversationId,
      content: row.content,
      ...(parseJsonTags(row.tagsJson) ? { tags: parseJsonTags(row.tagsJson) } : {}),
    }));
    const scored = scoreMemoryMatches(query, normalizedRows);
    return scored.slice(0, limit).map((entry) => entry.row);
  }

  private deserializeRuntimeThread(row: {
    threadKey: string;
    conversationId: string;
    agentType: string;
    name: string;
    status: "active" | "evicted";
    createdAt: number;
    lastUsedAt: number;
    summary: string | null;
  }): RuntimeThreadRecord {
    return {
      threadKey: row.threadKey,
      conversationId: row.conversationId,
      agentType: row.agentType,
      name: row.name,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }

  listActiveThreads(conversationId: string): RuntimeThreadRecord[] {
    const rows = this.db.prepare(`
      SELECT
        thread_key AS threadKey,
        conversation_id AS conversationId,
        agent_type AS agentType,
        name,
        status,
        created_at AS createdAt,
        last_used_at AS lastUsedAt,
        summary
      FROM runtime_threads
      WHERE conversation_id = ?
        AND status = 'active'
      ORDER BY last_used_at DESC
      LIMIT ?
    `).all(conversationId, MAX_ACTIVE_RUNTIME_THREADS) as Array<{
      threadKey: string;
      conversationId: string;
      agentType: string;
      name: string;
      status: "active" | "evicted";
      createdAt: number;
      lastUsedAt: number;
      summary: string | null;
    }>;
    return rows.map((row) => this.deserializeRuntimeThread(row));
  }

  resolveOrCreateActiveThread(args: {
    conversationId: string;
    agentType: string;
    threadName?: string;
  }): { threadId: string; threadName: string; reused: boolean } {
    const requestedName = normalizeRuntimeThreadName(args.threadName ?? "");
    const existing = requestedName
      ? this.db.prepare(`
        SELECT
          thread_key AS threadKey,
          conversation_id AS conversationId,
          agent_type AS agentType,
          name,
          status,
          created_at AS createdAt,
          last_used_at AS lastUsedAt,
          summary
        FROM runtime_threads
        WHERE conversation_id = ?
          AND status = 'active'
          AND name = ?
        LIMIT 1
      `).get(args.conversationId, requestedName) as {
        threadKey: string;
        conversationId: string;
        agentType: string;
        name: string;
        status: "active" | "evicted";
        createdAt: number;
        lastUsedAt: number;
        summary: string | null;
      } | undefined
      : undefined;

    if (existing) {
      this.touchThread(existing.threadKey);
      return {
        threadId: existing.threadKey,
        threadName: existing.name,
        reused: true,
      };
    }

    const activeThreads = this.listActiveThreads(args.conversationId);
    if (activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS) {
      const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'evicted'
          WHERE thread_key = ?
        `).run(oldest.threadKey);
      }
    }

    const activeNames = new Set(this.listActiveThreads(args.conversationId).map((thread) => thread.name));
    const selectedName =
      requestedName
        && RUNTIME_THREAD_NAME_POOL.includes(requestedName)
        && !activeNames.has(requestedName)
        ? requestedName
        : pickAvailableRuntimeThreadName(activeNames);
    const threadKey = buildRuntimeThreadKey({
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: selectedName,
      threadId: selectedName,
    });
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runtime_threads (
        thread_key,
        conversation_id,
        agent_type,
        name,
        status,
        created_at,
        last_used_at,
        summary
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
    `).run(
      threadKey,
      args.conversationId,
      args.agentType,
      selectedName,
      now,
      now,
    );
    this.forceOrchestratorReminderOnNextTurn(args.conversationId);
    return {
      threadId: threadKey,
      threadName: selectedName,
      reused: false,
    };
  }

  touchThread(threadKey: string): void {
    this.db.prepare(`
      UPDATE runtime_threads
      SET last_used_at = ?
      WHERE thread_key = ?
    `).run(Date.now(), threadKey);
  }

  updateThreadSummary(threadKey: string, summary: string): void {
    const trimmed = summary.trim();
    if (!trimmed) return;
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { conversationId?: unknown } | undefined;
    this.db.prepare(`
      UPDATE runtime_threads
      SET summary = ?, last_used_at = ?
      WHERE thread_key = ?
    `).run(trimmed, Date.now(), threadKey);
    if (typeof row?.conversationId === "string" && row.conversationId.length > 0) {
      this.forceOrchestratorReminderOnNextTurn(row.conversationId);
    }
  }

  getThreadName(threadKey: string): string | undefined {
    const row = this.db.prepare(`
      SELECT name
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { name?: unknown } | undefined;
    return typeof row?.name === "string" && row.name.length > 0 ? row.name : undefined;
  }

  getOrchestratorReminderState(conversationId: string): {
    shouldInjectDynamicReminder: boolean;
    reminderTokensSinceLastInjection: number;
  } {
    const row = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current = typeof row?.reminderTokensSinceLastInjection === "number"
      ? Math.max(0, Math.floor(row.reminderTokensSinceLastInjection))
      : 0;
    const shouldInjectDynamicReminder =
      row?.forceReminderOnNextTurn === 1
      || row?.reminderTokensSinceLastInjection == null
      || current >= RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS;
    return {
      shouldInjectDynamicReminder,
      reminderTokensSinceLastInjection: current,
    };
  }

  updateOrchestratorReminderCounter(args: {
    conversationId: string;
    resetTo?: number;
    incrementBy?: number;
  }): void {
    const currentState = this.db.prepare(`
      SELECT
        reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection,
        force_reminder_on_next_turn AS forceReminderOnNextTurn
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(args.conversationId) as {
      reminderTokensSinceLastInjection?: unknown;
      forceReminderOnNextTurn?: unknown;
    } | undefined;
    const current =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    const nextValue = args.resetTo != null
      ? Math.max(0, Math.floor(args.resetTo))
      : Math.max(0, Math.floor(current + (args.incrementBy ?? 0)));
    const forceReminderOnNextTurn = args.resetTo != null
      ? 0
      : currentState?.forceReminderOnNextTurn === 1
        ? 1
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = excluded.force_reminder_on_next_turn
    `).run(args.conversationId, nextValue, forceReminderOnNextTurn);
  }

  forceOrchestratorReminderOnNextTurn(conversationId: string): void {
    const currentState = this.db.prepare(`
      SELECT reminder_tokens_since_last_injection AS reminderTokensSinceLastInjection
      FROM runtime_conversation_state
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { reminderTokensSinceLastInjection?: unknown } | undefined;
    const reminderTokensSinceLastInjection =
      typeof currentState?.reminderTokensSinceLastInjection === "number"
        ? currentState.reminderTokensSinceLastInjection
        : 0;
    this.db.prepare(`
      INSERT INTO runtime_conversation_state (
        conversation_id,
        reminder_tokens_since_last_injection,
        force_reminder_on_next_turn
      )
      VALUES (?, ?, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        reminder_tokens_since_last_injection = excluded.reminder_tokens_since_last_injection,
        force_reminder_on_next_turn = 1
    `).run(conversationId, reminderTokensSinceLastInjection);
  }
}
