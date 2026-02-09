import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_EVENT_WINDOW_LIMIT = 200;
const DEFAULT_EVENT_SYNC_LIMIT = 400;
const DEFAULT_TASK_WINDOW_LIMIT = 200;
const DEFAULT_TASK_SYNC_LIMIT = 300;
const DEFAULT_THREAD_WINDOW_LIMIT = 32;
const DEFAULT_MEMORY_CATEGORY_LIMIT = 256;
const EVENT_RETENTION_LIMIT = 2000;
const FINISHED_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_REHYDRATE_INTERVAL_MS = 30 * 60 * 1000;
const isRecord = (value) => typeof value === "object" && value !== null;
const toStringValue = (value) => typeof value === "string" && value.length > 0 ? value : null;
const toNumberValue = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.floor(value)));
const safeParseObject = (value) => {
    try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)) {
            return parsed;
        }
    }
    catch {
        // Ignore parse failures for cache payloads.
    }
    return undefined;
};
const safeJson = (value) => {
    try {
        return JSON.stringify(value ?? {});
    }
    catch {
        return "{}";
    }
};
const normalizeEvent = (value) => {
    if (!isRecord(value))
        return null;
    const id = toStringValue(value._id);
    const timestamp = toNumberValue(value.timestamp);
    const type = toStringValue(value.type);
    if (!id || timestamp === null || !type) {
        return null;
    }
    return {
        _id: id,
        timestamp,
        type,
        deviceId: toStringValue(value.deviceId) ?? undefined,
        requestId: toStringValue(value.requestId) ?? undefined,
        targetDeviceId: toStringValue(value.targetDeviceId) ?? undefined,
        payload: value.payload,
    };
};
const normalizeTask = (value) => {
    if (!isRecord(value))
        return null;
    const id = toStringValue(value._id);
    const conversationId = toStringValue(value.conversationId);
    const status = toStringValue(value.status);
    const updatedAt = toNumberValue(value.updatedAt);
    if (!id || !conversationId || !status || updatedAt === null) {
        return null;
    }
    return {
        _id: id,
        conversationId,
        status,
        agentType: toStringValue(value.agentType) ?? undefined,
        description: toStringValue(value.description) ?? undefined,
        parentTaskId: toStringValue(value.parentTaskId) ?? undefined,
        result: toStringValue(value.result) ?? undefined,
        error: toStringValue(value.error) ?? undefined,
        updatedAt,
    };
};
const normalizeThread = (value) => {
    if (!isRecord(value))
        return null;
    const id = toStringValue(value._id);
    const title = toStringValue(value.title);
    const agentType = toStringValue(value.agentType);
    const status = toStringValue(value.status);
    const createdAt = toNumberValue(value.createdAt);
    const lastActiveAt = toNumberValue(value.lastActiveAt);
    if (!id || !title || !agentType || !status || createdAt === null || lastActiveAt === null) {
        return null;
    }
    return {
        _id: id,
        title,
        agentType,
        status,
        createdAt,
        lastActiveAt,
    };
};
const normalizeCategory = (value) => {
    if (!isRecord(value))
        return null;
    const category = toStringValue(value.category);
    const subcategory = toStringValue(value.subcategory);
    const count = toNumberValue(value.count);
    if (!category || !subcategory || count === null) {
        return null;
    }
    return { category, subcategory, count };
};
export class ConvexCacheStore {
    constructor(dbPath, runQuery) {
        this.runQuery = runQuery;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.migrate();
    }
    close() {
        this.db.close();
    }
    resetAll() {
        this.db.exec(`
      DELETE FROM event_cache;
      DELETE FROM task_cache;
      DELETE FROM thread_cache;
      DELETE FROM memory_category_cache;
      DELETE FROM cache_meta WHERE key <> 'schema_version';
    `);
    }
    getConversationEvents(conversationId, limit = DEFAULT_EVENT_WINDOW_LIMIT) {
        const bounded = clamp(limit, 1, EVENT_RETENTION_LIMIT);
        const rows = this.db
            .prepare(`SELECT event_id, timestamp_ms, type, device_id, request_id, target_device_id, payload_json
         FROM event_cache
         WHERE conversation_id = ?
         ORDER BY timestamp_ms DESC, event_id DESC
         LIMIT ?`)
            .all(conversationId, bounded);
        rows.reverse();
        return rows.map((row) => ({
            _id: row.event_id,
            timestamp: row.timestamp_ms,
            type: row.type,
            deviceId: row.device_id ?? undefined,
            requestId: row.request_id ?? undefined,
            targetDeviceId: row.target_device_id ?? undefined,
            payload: safeParseObject(row.payload_json),
        }));
    }
    async syncConversationEvents(conversationId, options) {
        const windowLimit = clamp(options?.limit ?? DEFAULT_EVENT_WINDOW_LIMIT, 1, EVENT_RETENTION_LIMIT);
        const syncLimit = clamp(options?.syncLimit ?? DEFAULT_EVENT_SYNC_LIMIT, 50, 1000);
        const cursorKey = `events_cursor:${conversationId}`;
        const fullSyncKey = `events_full_sync_at:${conversationId}`;
        const cursor = this.getMetaNumber(cursorKey, 0);
        const lastFullSyncAt = this.getMetaNumber(fullSyncKey, 0);
        const shouldFullSync = cursor <= 0 || Date.now() - lastFullSyncAt >= FULL_REHYDRATE_INTERVAL_MS;
        const remoteEvents = shouldFullSync
            ? await this.fetchRecentEvents(conversationId, syncLimit)
            : await this.fetchEventsSince(conversationId, cursor, syncLimit);
        if (remoteEvents.length > 0) {
            this.upsertEvents(conversationId, remoteEvents);
            const maxTimestamp = remoteEvents.reduce((max, event) => Math.max(max, event.timestamp), cursor);
            this.setMetaNumber(cursorKey, maxTimestamp);
        }
        if (shouldFullSync) {
            this.setMetaNumber(fullSyncKey, Date.now());
        }
        return this.getConversationEvents(conversationId, windowLimit);
    }
    getTasks(conversationId, limit = DEFAULT_TASK_WINDOW_LIMIT) {
        const bounded = clamp(limit, 1, 2000);
        const rows = this.db
            .prepare(`SELECT task_id, status, agent_type, description, parent_task_id, result_text, error_text, updated_at_ms
         FROM task_cache
         WHERE conversation_id = ?
         ORDER BY updated_at_ms DESC, task_id DESC
         LIMIT ?`)
            .all(conversationId, bounded);
        return rows.map((row) => ({
            _id: row.task_id,
            status: row.status,
            agentType: row.agent_type ?? undefined,
            description: row.description ?? undefined,
            parentTaskId: row.parent_task_id ?? undefined,
            result: row.result_text ?? undefined,
            error: row.error_text ?? undefined,
            updatedAt: row.updated_at_ms,
        }));
    }
    async syncTasks(conversationId, options) {
        const windowLimit = clamp(options?.limit ?? DEFAULT_TASK_WINDOW_LIMIT, 1, 2000);
        const syncLimit = clamp(options?.syncLimit ?? DEFAULT_TASK_SYNC_LIMIT, 50, 1000);
        const cursorKey = `tasks_cursor:${conversationId}`;
        const fullSyncKey = `tasks_full_sync_at:${conversationId}`;
        const cursor = this.getMetaNumber(cursorKey, 0);
        const lastFullSyncAt = this.getMetaNumber(fullSyncKey, 0);
        const shouldFullSync = cursor <= 0 || Date.now() - lastFullSyncAt >= FULL_REHYDRATE_INTERVAL_MS;
        const tasks = shouldFullSync
            ? await this.fetchRecentTasks(conversationId)
            : await this.fetchTasksSince(conversationId, cursor, syncLimit);
        if (tasks.length > 0) {
            this.upsertTasks(conversationId, tasks);
            const maxUpdatedAt = tasks.reduce((max, task) => Math.max(max, task.updatedAt), cursor);
            this.setMetaNumber(cursorKey, maxUpdatedAt);
        }
        if (shouldFullSync) {
            this.setMetaNumber(fullSyncKey, Date.now());
        }
        this.pruneFinishedTasks(conversationId);
        return this.getTasks(conversationId, windowLimit);
    }
    getThreads(conversationId, limit = DEFAULT_THREAD_WINDOW_LIMIT) {
        const bounded = clamp(limit, 1, 200);
        const rows = this.db
            .prepare(`SELECT thread_id, title, agent_type, status, created_at_ms, last_active_at_ms
         FROM thread_cache
         WHERE conversation_id = ?
         ORDER BY status ASC, last_active_at_ms DESC, thread_id DESC
         LIMIT ?`)
            .all(conversationId, bounded);
        return rows.map((row) => ({
            _id: row.thread_id,
            title: row.title,
            agentType: row.agent_type,
            status: row.status,
            createdAt: row.created_at_ms,
            lastActiveAt: row.last_active_at_ms,
        }));
    }
    async syncThreads(conversationId, options) {
        const windowLimit = clamp(options?.limit ?? DEFAULT_THREAD_WINDOW_LIMIT, 1, 200);
        const rows = await this.fetchActiveThreads(conversationId);
        this.replaceThreads(conversationId, rows);
        const maxLastActiveAt = rows.reduce((max, thread) => Math.max(max, thread.lastActiveAt), 0);
        this.setMetaNumber(`threads_cursor:${conversationId}`, maxLastActiveAt);
        return this.getThreads(conversationId, windowLimit);
    }
    getMemoryCategories(ownerId = "self", limit = DEFAULT_MEMORY_CATEGORY_LIMIT) {
        const bounded = clamp(limit, 1, 2000);
        const rows = this.db
            .prepare(`SELECT category, subcategory, count, updated_at_ms
         FROM memory_category_cache
         WHERE owner_id = ?
         ORDER BY category ASC, subcategory ASC
         LIMIT ?`)
            .all(ownerId, bounded);
        return rows.map((row) => ({
            category: row.category,
            subcategory: row.subcategory,
            count: row.count,
            updatedAt: row.updated_at_ms,
        }));
    }
    async syncMemoryCategories(ownerId = "self", options) {
        const windowLimit = clamp(options?.limit ?? DEFAULT_MEMORY_CATEGORY_LIMIT, 1, 2000);
        const rows = await this.fetchMemoryCategories();
        this.replaceMemoryCategories(ownerId, rows);
        this.setMetaNumber(`memory_categories_cursor:${ownerId}`, Date.now());
        return this.getMemoryCategories(ownerId, windowLimit);
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_cache (
        event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        device_id TEXT,
        request_id TEXT,
        target_device_id TEXT,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_cache_conv_ts
        ON event_cache(conversation_id, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS task_cache (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_type TEXT,
        description TEXT,
        parent_task_id TEXT,
        result_text TEXT,
        error_text TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_cache_conv_updated
        ON task_cache(conversation_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS thread_cache (
        thread_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_active_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_cache_conv_active
        ON thread_cache(conversation_id, status, last_active_at_ms DESC);

      CREATE TABLE IF NOT EXISTS memory_category_cache (
        owner_id TEXT NOT NULL,
        category TEXT NOT NULL,
        subcategory TEXT NOT NULL,
        count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(owner_id, category, subcategory)
      );
    `);
        const currentVersion = this.getMetaNumber("schema_version", 0);
        if (currentVersion !== CACHE_SCHEMA_VERSION) {
            this.resetAll();
            this.setMetaNumber("schema_version", CACHE_SCHEMA_VERSION);
        }
    }
    getMetaNumber(key, fallback) {
        const row = this.db
            .prepare("SELECT value FROM cache_meta WHERE key = ?")
            .get(key);
        if (!row || typeof row.value !== "string") {
            return fallback;
        }
        const parsed = Number(row.value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    setMetaNumber(key, value) {
        this.db
            .prepare(`INSERT INTO cache_meta (key, value, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at_ms = excluded.updated_at_ms`)
            .run(key, String(value), Date.now());
    }
    async fetchRecentEvents(conversationId, limit) {
        const result = await this.runQuery("events.listEvents", {
            conversationId,
            paginationOpts: {
                cursor: null,
                numItems: limit,
            },
        });
        const page = isRecord(result) && Array.isArray(result.page) ? result.page : [];
        return page
            .map((event) => normalizeEvent(event))
            .filter((event) => Boolean(event))
            .sort((a, b) => a.timestamp - b.timestamp ||
            a._id.localeCompare(b._id));
    }
    async fetchEventsSince(conversationId, afterTimestamp, limit) {
        try {
            const result = await this.runQuery("events.listEventsSince", {
                conversationId,
                afterTimestamp,
                limit,
            });
            const rows = Array.isArray(result) ? result : [];
            return rows
                .map((event) => normalizeEvent(event))
                .filter((event) => Boolean(event));
        }
        catch {
            return this.fetchRecentEvents(conversationId, limit);
        }
    }
    upsertEvents(conversationId, events) {
        const now = Date.now();
        const upsert = this.db.prepare(`INSERT INTO event_cache (
        event_id, conversation_id, timestamp_ms, type, device_id,
        request_id, target_device_id, payload_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        timestamp_ms = excluded.timestamp_ms,
        type = excluded.type,
        device_id = excluded.device_id,
        request_id = excluded.request_id,
        target_device_id = excluded.target_device_id,
        payload_json = excluded.payload_json,
        updated_at_ms = excluded.updated_at_ms`);
        const run = this.db.transaction((rows) => {
            for (const event of rows) {
                upsert.run(event._id, conversationId, event.timestamp, event.type, event.deviceId ?? null, event.requestId ?? null, event.targetDeviceId ?? null, safeJson(event.payload), now);
            }
        });
        run(events);
        this.pruneConversationEvents(conversationId);
    }
    pruneConversationEvents(conversationId) {
        this.db
            .prepare(`DELETE FROM event_cache
         WHERE conversation_id = ?
           AND event_id NOT IN (
             SELECT event_id
             FROM event_cache
             WHERE conversation_id = ?
             ORDER BY timestamp_ms DESC, event_id DESC
             LIMIT ?
           )`)
            .run(conversationId, conversationId, EVENT_RETENTION_LIMIT);
    }
    async fetchRecentTasks(conversationId) {
        const result = await this.runQuery("agent/tasks.listByConversation", {
            conversationId,
        });
        const rows = Array.isArray(result) ? result : [];
        return rows
            .map((task) => normalizeTask(task))
            .filter((task) => Boolean(task));
    }
    async fetchTasksSince(conversationId, afterUpdatedAt, limit) {
        try {
            const result = await this.runQuery("agent/tasks.listByConversationSince", {
                conversationId,
                afterUpdatedAt,
                limit,
            });
            const rows = Array.isArray(result) ? result : [];
            return rows
                .map((task) => normalizeTask(task))
                .filter((task) => Boolean(task));
        }
        catch {
            return this.fetchRecentTasks(conversationId);
        }
    }
    upsertTasks(conversationId, tasks) {
        const upsert = this.db.prepare(`INSERT INTO task_cache (
        task_id, conversation_id, status, agent_type, description,
        parent_task_id, result_text, error_text, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        status = excluded.status,
        agent_type = excluded.agent_type,
        description = excluded.description,
        parent_task_id = excluded.parent_task_id,
        result_text = excluded.result_text,
        error_text = excluded.error_text,
        updated_at_ms = excluded.updated_at_ms`);
        const run = this.db.transaction((rows) => {
            for (const task of rows) {
                upsert.run(task._id, conversationId, task.status, task.agentType ?? null, task.description ?? null, task.parentTaskId ?? null, task.result ?? null, task.error ?? null, task.updatedAt);
            }
        });
        run(tasks);
    }
    pruneFinishedTasks(conversationId) {
        const cutoff = Date.now() - FINISHED_TASK_RETENTION_MS;
        this.db
            .prepare(`DELETE FROM task_cache
         WHERE conversation_id = ?
           AND status <> 'running'
           AND updated_at_ms < ?`)
            .run(conversationId, cutoff);
    }
    async fetchActiveThreads(conversationId) {
        const result = await this.runQuery("data/threads.listActiveThreadsForConversation", {
            conversationId,
        });
        const rows = Array.isArray(result) ? result : [];
        return rows
            .map((thread) => normalizeThread(thread))
            .filter((thread) => Boolean(thread));
    }
    replaceThreads(conversationId, threads) {
        const now = Date.now();
        const del = this.db.prepare("DELETE FROM thread_cache WHERE conversation_id = ?");
        const upsert = this.db.prepare(`INSERT INTO thread_cache (
        thread_id, conversation_id, title, agent_type, status,
        created_at_ms, last_active_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        title = excluded.title,
        agent_type = excluded.agent_type,
        status = excluded.status,
        created_at_ms = excluded.created_at_ms,
        last_active_at_ms = excluded.last_active_at_ms,
        updated_at_ms = excluded.updated_at_ms`);
        const run = this.db.transaction((rows) => {
            del.run(conversationId);
            for (const thread of rows) {
                upsert.run(thread._id, conversationId, thread.title, thread.agentType, thread.status, thread.createdAt, thread.lastActiveAt, now);
            }
        });
        run(threads);
    }
    async fetchMemoryCategories() {
        const result = await this.runQuery("data/memory.listCategoriesForOwner", {});
        const rows = Array.isArray(result) ? result : [];
        return rows
            .map((category) => normalizeCategory(category))
            .filter((category) => Boolean(category));
    }
    replaceMemoryCategories(ownerId, categories) {
        const now = Date.now();
        const del = this.db.prepare("DELETE FROM memory_category_cache WHERE owner_id = ?");
        const upsert = this.db.prepare(`INSERT INTO memory_category_cache (
        owner_id, category, subcategory, count, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, category, subcategory) DO UPDATE SET
        count = excluded.count,
        updated_at_ms = excluded.updated_at_ms`);
        const run = this.db.transaction((rows) => {
            del.run(ownerId);
            for (const category of rows) {
                upsert.run(ownerId, category.category, category.subcategory, category.count, now);
            }
        });
        run(categories);
    }
}
