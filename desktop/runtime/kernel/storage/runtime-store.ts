import {
  MAX_ACTIVE_RUNTIME_THREADS,
  RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS,
  type RuntimeThreadRecord,
  normalizeRuntimeThreadId,
} from "../runtime-threads.js";
import type { SqliteDatabase } from "./shared.js";
import {
  MAX_RECALL_RESULTS,
  SQLITE_MEMORY_SCAN_LIMIT,
  parseRuntimeThreadPayload,
  type RuntimeMemory,
  type RuntimeRunEvent,
  type RuntimeThreadMessage,
  escapeSqlLike,
  parseRuntimeSelfModApplied,
  parseJsonTags,
  scoreMemoryMatches,
  toJsonValueString,
  toJsonString,
  toJsonTags,
} from "./shared.js";
import { TranscriptMirror } from "./transcript-mirror.js";

export type PersistedTaskRecord = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  taskDepth: number;
  maxTaskDepth?: number;
  parentTaskId?: string;
  systemPromptOverride?: string;
  toolsAllowlistOverride?: string[];
  omitCoreMemory: boolean;
  selfModMetadata?: {
    featureId?: string;
    packageId?: string;
    releaseNumber?: number;
    mode?: "author" | "install" | "update";
    displayName?: string;
    description?: string;
  };
  status: "running" | "completed" | "error" | "canceled";
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  updatedAt: number;
};

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
      SELECT timestamp, thread_key AS threadKey, role, content, tool_call_id AS toolCallId, payload_json AS payloadJson
      FROM runtime_thread_messages
      WHERE thread_key = ?
      ORDER BY timestamp ASC, id ASC
    `).all(threadKey) as Array<{
      timestamp: number;
      threadKey: string;
      role: "user" | "assistant" | "toolResult";
      content: string;
      toolCallId: string | null;
      payloadJson: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      threadKey: row.threadKey,
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      ...(parseRuntimeThreadPayload(row.payloadJson)
        ? { payload: parseRuntimeThreadPayload(row.payloadJson) }
        : {}),
    }));
  }

  private rebuildRuntimeThreadTranscript(threadKey: string): void {
    this.mirror.writeRuntimeThread(threadKey, this.listAllThreadMessages(threadKey));
  }

  appendThreadMessage(message: RuntimeThreadMessage): void {
    const threadKey = this.sanitizeThreadKey(message.threadKey);
    this.db.prepare(`
      INSERT INTO runtime_thread_messages (thread_key, timestamp, role, content, tool_call_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      threadKey,
      message.timestamp,
      message.role,
      message.content,
      message.toolCallId ?? null,
      toJsonValueString(message.payload) ?? null,
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
  ): Array<{
    timestamp: number;
    role: RuntimeThreadMessage["role"];
    content: string;
    toolCallId?: string;
    payload?: RuntimeThreadMessage["payload"];
  }> {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    const sql = `
      SELECT timestamp, role, content, tool_call_id AS toolCallId, payload_json AS payloadJson
      FROM (
        SELECT id, timestamp, role, content, tool_call_id, payload_json
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
      timestamp: number;
      role: RuntimeThreadMessage["role"];
      content: string;
      toolCallId: string | null;
      payloadJson: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      ...(parseRuntimeThreadPayload(row.payloadJson)
        ? { payload: parseRuntimeThreadPayload(row.payloadJson) }
        : {}),
    }));
  }

  replaceThreadMessages(threadKeyInput: string, nextMessages: RuntimeThreadMessage[]): void {
    const threadKey = this.sanitizeThreadKey(threadKeyInput);
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM runtime_thread_messages WHERE thread_key = ?").run(threadKey);
      const stmt = this.db.prepare(`
        INSERT INTO runtime_thread_messages (thread_key, timestamp, role, content, tool_call_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const message of nextMessages) {
        stmt.run(
          threadKey,
          message.timestamp,
          message.role,
          message.content,
          message.toolCallId ?? null,
          toJsonValueString(message.payload) ?? null,
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
    return rows.map((row) => {
      const selfModApplied = parseRuntimeSelfModApplied(row.selfModAppliedJson);
      return {
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
        ...(selfModApplied ? { selfModApplied } : {}),
      };
    });
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
    return rows.map((row) => {
      const tags = parseJsonTags(row.tagsJson);
      return {
        timestamp: row.timestamp,
        conversationId: row.conversationId,
        content: row.content,
        ...(tags ? { tags } : {}),
      };
    });
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
    const normalizedRows: RuntimeMemory[] = rows.map((row) => {
      const tags = parseJsonTags(row.tagsJson);
      return {
        timestamp: row.timestamp,
        conversationId: row.conversationId,
        content: row.content,
        ...(tags ? { tags } : {}),
      };
    });
    const scored = scoreMemoryMatches(query, normalizedRows);
    return scored.slice(0, limit).map((entry) => entry.row);
  }

  private deserializeRuntimeThread(row: {
    threadId: string;
    conversationId: string;
    agentType: string;
    status: "active" | "evicted";
    createdAt: number;
    lastUsedAt: number;
    summary: string | null;
  }): RuntimeThreadRecord {
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      agentType: row.agentType,
      status: row.status,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(row.summary ? { summary: row.summary } : {}),
    };
  }

  listActiveThreads(conversationId: string): RuntimeThreadRecord[] {
    const rows = this.db.prepare(`
      SELECT
        thread_key AS threadId,
        conversation_id AS conversationId,
        agent_type AS agentType,
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
      threadId: string;
      conversationId: string;
      agentType: string;
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
    threadId?: string;
  }): { threadId: string; reused: boolean } {
    const requestedThreadId = normalizeRuntimeThreadId(args.threadId ?? "");
    const existing = requestedThreadId
      ? this.db.prepare(`
        SELECT
          thread_key AS threadId,
          conversation_id AS conversationId,
          agent_type AS agentType,
          status,
          created_at AS createdAt,
          last_used_at AS lastUsedAt,
          summary
        FROM runtime_threads
        WHERE thread_key = ?
        LIMIT 1
      `).get(requestedThreadId) as {
        threadId: string;
        conversationId: string;
        agentType: string;
        status: "active" | "evicted";
        createdAt: number;
        lastUsedAt: number;
        summary: string | null;
      } | undefined
      : undefined;

    if (existing) {
      if (
        existing.conversationId !== args.conversationId
        || existing.agentType !== args.agentType
      ) {
        throw new Error(`Thread ${existing.threadId} belongs to a different conversation or agent type.`);
      }
      const activeThreads = this.listActiveThreads(args.conversationId);
      if (
        existing.status !== "active"
        && activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS
      ) {
        const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (oldest) {
          this.db.prepare(`
            UPDATE runtime_threads
            SET status = 'evicted'
            WHERE thread_key = ?
          `).run(oldest.threadId);
        }
      }
      if (existing.status !== "active") {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'active'
          WHERE thread_key = ?
        `).run(existing.threadId);
      }
      this.touchThread(existing.threadId);
      return {
        threadId: existing.threadId,
        reused: true,
      };
    }

    const activeThreads = this.listActiveThreads(args.conversationId);
    const didEvict = activeThreads.length >= MAX_ACTIVE_RUNTIME_THREADS;
    if (didEvict) {
      const oldest = [...activeThreads].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) {
        this.db.prepare(`
          UPDATE runtime_threads
          SET status = 'evicted'
          WHERE thread_key = ?
        `).run(oldest.threadId);
      }
    }

    const prefix = `${args.agentType}-`;
    const rows = this.db.prepare(`
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE agent_type = ?
    `).all(args.agentType) as Array<{ threadId: string }>;
    let nextOrdinal = 1;
    for (const row of rows) {
      if (!row.threadId.startsWith(prefix)) continue;
      const suffix = Number.parseInt(row.threadId.slice(prefix.length), 10);
      if (Number.isFinite(suffix) && suffix >= nextOrdinal) {
        nextOrdinal = suffix + 1;
      }
    }
    const threadId = requestedThreadId ?? `${prefix}${nextOrdinal}`;
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
      threadId,
      args.conversationId,
      args.agentType,
      threadId,
      now,
      now,
    );
    this.forceOrchestratorReminderOnNextTurn(args.conversationId);
    return {
      threadId,
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
      SELECT thread_key AS threadId
      FROM runtime_threads
      WHERE thread_key = ?
      LIMIT 1
    `).get(threadKey) as { threadId?: unknown } | undefined;
    return typeof row?.threadId === "string" && row.threadId.length > 0 ? row.threadId : undefined;
  }

  saveTaskRecord(record: PersistedTaskRecord): void {
    this.db.prepare(`
      INSERT INTO runtime_tasks (
        thread_id,
        conversation_id,
        agent_type,
        description,
        task_depth,
        max_task_depth,
        parent_task_id,
        system_prompt_override,
        tools_allowlist_override_json,
        omit_core_memory,
        self_mod_metadata_json,
        status,
        started_at,
        completed_at,
        result,
        error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        agent_type = excluded.agent_type,
        description = excluded.description,
        task_depth = excluded.task_depth,
        max_task_depth = excluded.max_task_depth,
        parent_task_id = excluded.parent_task_id,
        system_prompt_override = excluded.system_prompt_override,
        tools_allowlist_override_json = excluded.tools_allowlist_override_json,
        omit_core_memory = excluded.omit_core_memory,
        self_mod_metadata_json = excluded.self_mod_metadata_json,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      record.threadId,
      record.conversationId,
      record.agentType,
      record.description,
      record.taskDepth,
      record.maxTaskDepth ?? null,
      record.parentTaskId ?? null,
      record.systemPromptOverride ?? null,
      toJsonString(record.toolsAllowlistOverride) ?? null,
      record.omitCoreMemory ? 1 : 0,
      toJsonString(record.selfModMetadata) ?? null,
      record.status,
      record.startedAt,
      record.completedAt ?? null,
      record.result ?? null,
      record.error ?? null,
      record.updatedAt,
    );
  }

  getTaskRecord(threadId: string): PersistedTaskRecord | null {
    const row = this.db.prepare(`
      SELECT
        thread_id AS threadId,
        conversation_id AS conversationId,
        agent_type AS agentType,
        description,
        task_depth AS taskDepth,
        max_task_depth AS maxTaskDepth,
        parent_task_id AS parentTaskId,
        system_prompt_override AS systemPromptOverride,
        tools_allowlist_override_json AS toolsAllowlistOverrideJson,
        omit_core_memory AS omitCoreMemory,
        self_mod_metadata_json AS selfModMetadataJson,
        status,
        started_at AS startedAt,
        completed_at AS completedAt,
        result,
        error,
        updated_at AS updatedAt
      FROM runtime_tasks
      WHERE thread_id = ?
      LIMIT 1
    `).get(threadId) as
      | {
          threadId: string;
          conversationId: string;
          agentType: string;
          description: string;
          taskDepth: number;
          maxTaskDepth: number | null;
          parentTaskId: string | null;
          systemPromptOverride: string | null;
          toolsAllowlistOverrideJson: string | null;
          omitCoreMemory: number;
          selfModMetadataJson: string | null;
          status: PersistedTaskRecord["status"];
          startedAt: number;
          completedAt: number | null;
          result: string | null;
          error: string | null;
          updatedAt: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    let toolsAllowlistOverride: string[] | undefined;
    if (row.toolsAllowlistOverrideJson) {
      try {
        const parsed = JSON.parse(row.toolsAllowlistOverrideJson);
        if (Array.isArray(parsed)) {
          toolsAllowlistOverride = parsed.filter(
            (value): value is string => typeof value === "string",
          );
        }
      } catch {
        toolsAllowlistOverride = undefined;
      }
    }
    let selfModMetadata: PersistedTaskRecord["selfModMetadata"] | undefined;
    if (row.selfModMetadataJson) {
      try {
        selfModMetadata = JSON.parse(row.selfModMetadataJson) as PersistedTaskRecord["selfModMetadata"];
      } catch {
        selfModMetadata = undefined;
      }
    }
    return {
      threadId: row.threadId,
      conversationId: row.conversationId,
      agentType: row.agentType,
      description: row.description,
      taskDepth: row.taskDepth,
      ...(row.maxTaskDepth == null ? {} : { maxTaskDepth: row.maxTaskDepth }),
      ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
      ...(row.systemPromptOverride ? { systemPromptOverride: row.systemPromptOverride } : {}),
      ...(toolsAllowlistOverride ? { toolsAllowlistOverride } : {}),
      omitCoreMemory: row.omitCoreMemory === 1,
      ...(selfModMetadata ? { selfModMetadata } : {}),
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updatedAt,
    };
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
