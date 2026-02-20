/**
 * Local HTTP server (Hono) — serves all local-first API endpoints.
 * Runs on localhost:9714 in the Electron main process.
 * Replaces Convex live queries and mutations for local data.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import {
  getDb, closeDb, newId, insert, update, remove,
  findById, query, rawQuery, rawRun, transaction,
  markSyncRowsDirty,
} from "./db.js";
import type { Server } from "http";
import { handleChat, type ChatRequest, type RuntimeConfig } from "./agent/runtime.js";

const log = (...args: unknown[]) => console.log("[local-server]", ...args);
const logError = (...args: unknown[]) => console.error("[local-server]", ...args);

const LOCAL_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;
const DEFAULT_CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-Device-ID, Accept, Cache-Control, Last-Event-ID";

function resolveAllowedOrigin(origin?: string): string | null {
  if (!origin) return null;
  if (origin === "null") return "null";
  return LOCAL_ORIGIN_PATTERN.test(origin) ? origin : null;
}

function appendVary(current: string | null, value: string): string {
  if (!current || current.trim() === "") return value;
  const parts = current
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}

// Runtime config, set during server startup
let runtimeConfig: RuntimeConfig | null = null;

export function setRuntimeConfig(config: RuntimeConfig): void {
  runtimeConfig = config;
}

// ─── SSE Connection Manager ─────────────────────────────────────────────────

type SSEController = {
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const sseConnections = new Map<string, Set<SSEController>>();

function broadcastSSE(conversationId: string, event: string, data: unknown) {
  const conns = sseConnections.get(conversationId);
  if (!conns) return;
  for (const ctrl of conns) {
    try {
      ctrl.send(event, data);
    } catch {
      // Connection may be closed
    }
  }
}

function broadcastGlobal(event: string, data: unknown) {
  for (const [, conns] of sseConnections) {
    for (const ctrl of conns) {
      try {
        ctrl.send(event, data);
      } catch {}
    }
  }
}

// ─── Hono App ────────────────────────────────────────────────────────────────

const app = new Hono();

// Local renderer runs on a different localhost port in dev mode, so local host
// APIs must support CORS preflight and explicit origin allowlisting.
app.use("*", async (c, next) => {
  const allowedOrigin = resolveAllowedOrigin(c.req.header("origin"));

  if (c.req.method === "OPTIONS") {
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Vary", appendVary(c.res.headers.get("Vary"), "Origin"));
    }
    c.header("Access-Control-Allow-Methods", DEFAULT_CORS_ALLOW_METHODS);
    c.header(
      "Access-Control-Allow-Headers",
      c.req.header("Access-Control-Request-Headers") || DEFAULT_CORS_ALLOW_HEADERS,
    );
    c.header("Access-Control-Max-Age", "600");
    return c.body(null, 204);
  }

  await next();

  if (allowedOrigin) {
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Vary", appendVary(c.res.headers.get("Vary"), "Origin"));
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// ─── Chat (Agent Loop) ──────────────────────────────────────────────────────

app.post("/api/chat", async (c) => {
  if (!runtimeConfig) {
    return c.json({ error: "Runtime not initialized" }, 503);
  }

  const body = await c.req.json<ChatRequest>();
  if (!body?.conversationId || !body?.userMessageId) {
    return c.json({ error: "conversationId and userMessageId are required" }, 400);
  }

  const response = await handleChat(body, runtimeConfig);
  return response;
});

// ─── SSE Stream ──────────────────────────────────────────────────────────────

app.get("/api/sse", (c) => {
  const conversationId = c.req.query("conversationId");
  if (!conversationId) {
    return c.json({ error: "conversationId required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const controller: SSEController = {
      send: (event, data) => {
        stream.writeSSE({
          event,
          data: JSON.stringify(data),
          id: newId(),
        });
      },
      close: () => {
        stream.close();
      },
    };

    if (!sseConnections.has(conversationId)) {
      sseConnections.set(conversationId, new Set());
    }
    sseConnections.get(conversationId)!.add(controller);

    // Send initial ping
    stream.writeSSE({ event: "ping", data: "{}", id: "0" });

    // Keep alive with periodic pings
    const pingInterval = setInterval(() => {
      try {
        stream.writeSSE({ event: "ping", data: "{}", id: "0" });
      } catch {
        clearInterval(pingInterval);
      }
    }, 30_000);

    // Wait for abort
    try {
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      clearInterval(pingInterval);
      sseConnections.get(conversationId)?.delete(controller);
      if (sseConnections.get(conversationId)?.size === 0) {
        sseConnections.delete(conversationId);
      }
    }
  });
});

// ─── Conversations ───────────────────────────────────────────────────────────

app.get("/api/conversations", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  const rows = query("conversations", {
    where: { owner_id: ownerId },
    orderBy: "updated_at",
    order: "DESC",
    limit: 50,
  });
  return c.json(rows);
});

app.post("/api/conversations", async (c) => {
  const body = await c.req.json<{ ownerId?: string; title?: string }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();
  const id = insert("conversations", {
    owner_id: ownerId,
    title: body.title || null,
    is_default: 0,
    created_at: now,
    updated_at: now,
  });
  const row = findById("conversations", id);
  return c.json(row, 201);
});

app.post("/api/conversations/default", async (c) => {
  const body = await c.req.json<{ ownerId?: string }>().catch(() => ({}));
  const ownerId = (body as { ownerId?: string }).ownerId || "local";

  // Find existing default
  const existing = rawQuery<Record<string, unknown>>(
    "SELECT * FROM conversations WHERE owner_id = ? AND is_default = 1 ORDER BY updated_at DESC LIMIT 1",
    [ownerId],
  );

  if (existing.length > 0) {
    return c.json(existing[0]);
  }

  // Create new default
  const now = Date.now();
  const id = insert("conversations", {
    owner_id: ownerId,
    title: null,
    is_default: 1,
    created_at: now,
    updated_at: now,
  });
  const row = findById("conversations", id);
  return c.json(row, 201);
});

app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();
  const data: Record<string, unknown> = { updated_at: Date.now() };
  if ("title" in body) data.title = body.title;
  if ("tokenCount" in body) data.token_count = body.tokenCount;
  update("conversations", data, { id });
  const row = findById("conversations", id);
  return c.json(row);
});

app.delete("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  remove("conversations", { id });
  return c.json({ ok: true });
});

// ─── Events ──────────────────────────────────────────────────────────────────

app.get("/api/events", (c) => {
  const conversationId = c.req.query("conversationId");
  if (!conversationId) return c.json({ error: "conversationId required" }, 400);

  const limit = parseInt(c.req.query("limit") || "100", 10);
  const before = c.req.query("before");

  let sql = "SELECT * FROM events WHERE conversation_id = ?";
  const params: unknown[] = [conversationId];

  if (before) {
    sql += " AND timestamp < ?";
    params.push(parseFloat(before));
  }

  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const rows = rawQuery(sql, params);
  // Return in chronological order
  rows.reverse();
  return c.json(rows);
});

app.post("/api/events", async (c) => {
  const body = await c.req.json<{
    conversationId: string;
    type: string;
    payload?: unknown;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
  }>();

  const now = Date.now();
  const id = insert("events", {
    conversation_id: body.conversationId,
    timestamp: now,
    type: body.type,
    payload: body.payload || {},
    device_id: body.deviceId || null,
    request_id: body.requestId || newId(),
    target_device_id: body.targetDeviceId || null,
  });

  // Update conversation updated_at
  update("conversations", { updated_at: now }, { id: body.conversationId });

  const event = findById("events", id);

  // Broadcast to SSE listeners
  broadcastSSE(body.conversationId, "event_added", event);

  return c.json(event, 201);
});

app.post("/api/attachments/create", async (c) => {
  const body = await c.req.json<{
    conversationId: string;
    deviceId: string;
    dataUrl: string;
  }>();
  if (!body?.conversationId || !body?.deviceId || !body?.dataUrl) {
    return c.json({ error: "conversationId, deviceId, and dataUrl are required" }, 400);
  }

  const parsed = parseDataUrl(body.dataUrl);
  if (!parsed) {
    return c.json({ error: "Invalid data URL" }, 400);
  }

  const id = newId();
  const storageKey = `local:${id}`;
  insert("attachments", {
    id,
    conversation_id: body.conversationId,
    device_id: body.deviceId,
    storage_key: storageKey,
    // Keep local attachments directly addressable in message payloads.
    url: body.dataUrl,
    mime_type: parsed.mimeType,
    size: parsed.size,
    created_at: Date.now(),
  });

  return c.json(
    {
      _id: id,
      storageKey,
      url: body.dataUrl,
      mimeType: parsed.mimeType,
      size: parsed.size,
    },
    201,
  );
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

app.get("/api/tasks", (c) => {
  const conversationId = c.req.query("conversationId");
  if (!conversationId) return c.json({ error: "conversationId required" }, 400);

  const rows = query("tasks", {
    where: { conversation_id: conversationId },
    orderBy: "created_at",
    order: "DESC",
    limit: 50,
  });
  return c.json(rows);
});

app.get("/api/tasks/:id", (c) => {
  const id = c.req.param("id");
  const row = findById("tasks", id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.post("/api/tasks/:id/cancel", (c) => {
  const id = c.req.param("id");
  const now = Date.now();
  update("tasks", {
    status: "cancelled",
    updated_at: now,
    completed_at: now,
  }, { id });
  const row = findById("tasks", id);

  // Broadcast update
  if (row) {
    const convId = (row as Record<string, unknown>).conversation_id as string;
    broadcastSSE(convId, "task_updated", row);
  }

  return c.json(row);
});

// ─── Preferences ─────────────────────────────────────────────────────────────

app.get("/api/preferences", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  const rows = query("user_preferences", { where: { owner_id: ownerId } });
  return c.json(rows);
});

app.get("/api/preferences/:key", (c) => {
  const key = c.req.param("key");
  const ownerId = c.req.query("ownerId") || "local";
  const rows = rawQuery(
    "SELECT * FROM user_preferences WHERE owner_id = ? AND key = ?",
    [ownerId, key],
  );
  if (rows.length === 0) return c.json(null);
  return c.json(rows[0]);
});

app.put("/api/preferences/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ value: string; ownerId?: string }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();

  const existing = rawQuery(
    "SELECT id FROM user_preferences WHERE owner_id = ? AND key = ?",
    [ownerId, key],
  );

  if (existing.length > 0) {
    update("user_preferences", { value: body.value, updated_at: now }, {
      id: (existing[0] as { id: string }).id,
    });
  } else {
    insert("user_preferences", {
      owner_id: ownerId,
      key,
      value: body.value,
      updated_at: now,
    });
  }

  return c.json({ ok: true });
});

app.delete("/api/preferences/:key", (c) => {
  const key = c.req.param("key");
  const ownerId = c.req.query("ownerId") || "local";
  const existing = rawQuery<{ id: string }>(
    "SELECT id FROM user_preferences WHERE owner_id = ? AND key = ?",
    [ownerId, key],
  );
  rawRun("DELETE FROM user_preferences WHERE owner_id = ? AND key = ?", [ownerId, key]);
  if (existing.length > 0) {
    markSyncRowsDirty(
      "user_preferences",
      existing.map((row) => row.id),
    );
  }
  return c.json({ ok: true });
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

app.get("/api/secrets", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  // Return list without the encrypted values
  const rows = rawQuery(
    "SELECT id, owner_id, provider, label, key_version, status, metadata, created_at, updated_at, last_used_at FROM secrets WHERE owner_id = ?",
    [ownerId],
  );
  return c.json(rows);
});

app.post("/api/secrets", async (c) => {
  const body = await c.req.json<{
    ownerId?: string;
    provider: string;
    label: string;
    encryptedValue: string;
    keyVersion?: number;
  }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();

  // Upsert by provider
  const existing = rawQuery(
    "SELECT id FROM secrets WHERE owner_id = ? AND provider = ?",
    [ownerId, body.provider],
  );
  let secretId: string;

  if (existing.length > 0) {
    secretId = (existing[0] as { id: string }).id;
    update("secrets", {
      label: body.label,
      encrypted_value: body.encryptedValue,
      key_version: body.keyVersion || 1,
      updated_at: now,
    }, { id: secretId });
  } else {
    secretId = insert("secrets", {
      owner_id: ownerId,
      provider: body.provider,
      label: body.label,
      encrypted_value: body.encryptedValue,
      key_version: body.keyVersion || 1,
      status: "active",
      created_at: now,
      updated_at: now,
    });
  }

  return c.json({ ok: true, secretId });
});

app.delete("/api/secrets/:id", (c) => {
  const id = c.req.param("id");
  remove("secrets", { id });
  return c.json({ ok: true });
});

// ─── Canvas State ────────────────────────────────────────────────────────────

app.get("/api/canvas/state", (c) => {
  const conversationId = c.req.query("conversationId");
  const ownerId = c.req.query("ownerId") || "local";
  if (!conversationId) return c.json(null);

  const rows = rawQuery(
    "SELECT * FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
    [ownerId, conversationId],
  );
  return c.json(rows.length > 0 ? rows[0] : null);
});

app.get("/api/canvas-states/:conversationId", (c) => {
  const conversationId = c.req.param("conversationId");
  const ownerId = c.req.query("ownerId") || "local";
  const rows = rawQuery(
    "SELECT * FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
    [ownerId, conversationId],
  );
  return c.json(rows.length > 0 ? rows[0] : null);
});

app.put("/api/canvas/state", async (c) => {
  const body = await c.req.json<{
    conversationId: string;
    ownerId?: string;
    name: string;
    title?: string;
    url?: string;
    width?: number;
  }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();

  const existing = rawQuery(
    "SELECT id FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
    [ownerId, body.conversationId],
  );

  if (existing.length > 0) {
    update("canvas_states", {
      name: body.name,
      title: body.title || null,
      url: body.url || null,
      width: body.width || null,
      updated_at: now,
    }, { id: (existing[0] as { id: string }).id });
  } else {
    insert("canvas_states", {
      owner_id: ownerId,
      conversation_id: body.conversationId,
      name: body.name,
      title: body.title || null,
      url: body.url || null,
      width: body.width || null,
      updated_at: now,
    });
  }

  return c.json({ ok: true });
});

app.delete("/api/canvas/state", (c) => {
  const conversationId = c.req.query("conversationId");
  const ownerId = c.req.query("ownerId") || "local";
  if (conversationId) {
    const existing = rawQuery<{ id: string }>(
      "SELECT id FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
      [ownerId, conversationId],
    );
    rawRun(
      "DELETE FROM canvas_states WHERE owner_id = ? AND conversation_id = ?",
      [ownerId, conversationId],
    );
    if (existing.length > 0) {
      markSyncRowsDirty(
        "canvas_states",
        existing.map((row) => row.id),
      );
    }
  }
  return c.json({ ok: true });
});

// ─── Skills ──────────────────────────────────────────────────────────────────

app.get("/api/skills", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  const enabledOnly = c.req.query("enabledOnly") !== "false";

  if (enabledOnly) {
    return c.json(rawQuery(
      "SELECT * FROM skills WHERE (owner_id = ? OR owner_id IS NULL) AND enabled = 1 ORDER BY updated_at DESC",
      [ownerId],
    ));
  }

  return c.json(rawQuery(
    "SELECT * FROM skills WHERE (owner_id = ? OR owner_id IS NULL) ORDER BY updated_at DESC",
    [ownerId],
  ));
});

// ─── Agents ──────────────────────────────────────────────────────────────────

app.get("/api/agents/:type", (c) => {
  const agentType = c.req.param("type");
  const ownerId = c.req.query("ownerId") || "local";

  // Find agent config matching agent type
  const rows = rawQuery(
    "SELECT * FROM agents WHERE (owner_id = ? OR owner_id IS NULL) AND agent_types LIKE ? ORDER BY updated_at DESC LIMIT 1",
    [ownerId, `%"${agentType}"%`],
  );
  if (rows.length === 0) return c.json(null);
  return c.json(rows[0]);
});

// ─── Memories ────────────────────────────────────────────────────────────────

app.post("/api/memories/recall", async (c) => {
  const body = await c.req.json<{ ownerId?: string; query: string; embedding?: number[] }>();
  const ownerId = body.ownerId || "local";

  if (!body.embedding) {
    // Without embedding, do text search fallback
    const rows = rawQuery(
      "SELECT * FROM memories WHERE owner_id = ? ORDER BY accessed_at DESC LIMIT 10",
      [ownerId],
    );
    return c.json(rows);
  }

  // Vector search: brute-force cosine similarity in JS
  const allMemories = rawQuery<{
    id: string;
    content: string;
    embedding: string | number[];
    accessed_at: number;
  }>(
    "SELECT * FROM memories WHERE owner_id = ? AND embedding IS NOT NULL",
    [ownerId],
  );

  const queryVec = body.embedding;
  const scored = allMemories
    .map((mem) => {
      const memVec = typeof mem.embedding === "string"
        ? JSON.parse(mem.embedding) as number[]
        : mem.embedding;
      if (!Array.isArray(memVec) || memVec.length !== queryVec.length) {
        return { ...mem, score: 0 };
      }
      const score = cosineSimilarity(queryVec, memVec);
      return { ...mem, score };
    })
    .filter((m) => m.score > 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Update accessed_at for recalled memories
  const now = Date.now();
  for (const mem of scored) {
    update("memories", { accessed_at: now }, { id: mem.id });
  }

  return c.json(scored);
});

app.post("/api/memories/save", async (c) => {
  const body = await c.req.json<{
    ownerId?: string;
    content: string;
    embedding?: number[];
    conversationId?: string;
  }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();

  // Dedup check via embedding similarity
  if (body.embedding) {
    const existing = rawQuery<{
      id: string;
      embedding: string | number[];
    }>(
      "SELECT id, embedding FROM memories WHERE owner_id = ? AND embedding IS NOT NULL",
      [ownerId],
    );

    for (const mem of existing) {
      const memVec = typeof mem.embedding === "string"
        ? JSON.parse(mem.embedding) as number[]
        : mem.embedding;
      if (!Array.isArray(memVec)) continue;
      const sim = cosineSimilarity(body.embedding, memVec);
      if (sim > 0.9) {
        // Too similar — skip
        return c.json({ id: mem.id, deduplicated: true });
      }
    }
  }

  // Enforce 500-memory cap
  const countResult = rawQuery<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM memories WHERE owner_id = ?",
    [ownerId],
  );
  if (countResult[0]?.cnt >= 500) {
    // Delete least-accessed
    const toDelete = rawQuery<{ id: string }>(
      "SELECT id FROM memories WHERE owner_id = ? ORDER BY accessed_at ASC LIMIT 1",
      [ownerId],
    );
    rawRun(
      "DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE owner_id = ? ORDER BY accessed_at ASC LIMIT 1)",
      [ownerId],
    );
    if (toDelete.length > 0) {
      markSyncRowsDirty("memories", toDelete.map((row) => row.id));
    }
  }

  const id = insert("memories", {
    owner_id: ownerId,
    conversation_id: body.conversationId || null,
    content: body.content,
    embedding: body.embedding ? JSON.stringify(body.embedding) : null,
    accessed_at: now,
    created_at: now,
  });

  return c.json({ id, deduplicated: false }, 201);
});

// ─── Store ───────────────────────────────────────────────────────────────────

app.get("/api/store/packages", (c) => {
  const type = c.req.query("type");
  const search = c.req.query("search");

  if (search) {
    return c.json(rawQuery(
      "SELECT * FROM store_packages WHERE search_text LIKE ? ORDER BY downloads DESC LIMIT 50",
      [`%${search}%`],
    ));
  }

  if (type) {
    return c.json(rawQuery(
      "SELECT * FROM store_packages WHERE type = ? ORDER BY downloads DESC LIMIT 50",
      [type],
    ));
  }

  return c.json(rawQuery(
    "SELECT * FROM store_packages ORDER BY downloads DESC LIMIT 50",
    [],
  ));
});

app.get("/api/store/installed", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  const rows = rawQuery(
    `SELECT si.*, sp.name, sp.type, sp.description, sp.icon
     FROM store_installs si
     LEFT JOIN store_packages sp ON si.package_id = sp.package_id
     WHERE si.owner_id = ?
     ORDER BY si.installed_at DESC`,
    [ownerId],
  );
  return c.json(rows);
});

app.post("/api/store/install", async (c) => {
  const body = await c.req.json<{
    ownerId?: string;
    packageId: string;
    version: string;
  }>();
  const ownerId = body.ownerId || "local";
  const now = Date.now();

  // Upsert
  const existing = rawQuery(
    "SELECT id FROM store_installs WHERE owner_id = ? AND package_id = ?",
    [ownerId, body.packageId],
  );

  if (existing.length > 0) {
    update("store_installs", {
      installed_version: body.version,
      installed_at: now,
    }, { id: (existing[0] as { id: string }).id });
  } else {
    insert("store_installs", {
      owner_id: ownerId,
      package_id: body.packageId,
      installed_version: body.version,
      installed_at: now,
    });
  }

  return c.json({ ok: true });
});

app.post("/api/store/uninstall", async (c) => {
  const body = await c.req.json<{ ownerId?: string; packageId: string }>();
  const ownerId = body.ownerId || "local";
  const existing = rawQuery<{ id: string }>(
    "SELECT id FROM store_installs WHERE owner_id = ? AND package_id = ?",
    [ownerId, body.packageId],
  );
  rawRun(
    "DELETE FROM store_installs WHERE owner_id = ? AND package_id = ?",
    [ownerId, body.packageId],
  );
  if (existing.length > 0) {
    markSyncRowsDirty(
      "store_installs",
      existing.map((row) => row.id),
    );
  }
  return c.json({ ok: true });
});

// ─── STT ─────────────────────────────────────────────────────────────────────

const buildSttProxyHeaders = (): Record<string, string> | null => {
  if (!runtimeConfig) return null;
  const headers: Record<string, string> = {
    "X-Device-ID": runtimeConfig.deviceId,
  };
  if (runtimeConfig.authToken) {
    headers.Authorization = `Bearer ${runtimeConfig.authToken}`;
  }
  return headers;
};

const resolveSttProxyUrl = (): string | null => {
  if (!runtimeConfig?.proxyUrl) return null;
  return `${runtimeConfig.proxyUrl.replace(/\/+$/, "")}/api/stt`;
};

const fetchSttAvailability = async (): Promise<{ available: boolean }> => {
  const sttProxyUrl = resolveSttProxyUrl();
  const headers = buildSttProxyHeaders();
  if (!sttProxyUrl || !headers) {
    return { available: false };
  }

  try {
    const response = await fetch(`${sttProxyUrl}/check-available`, { headers });
    if (!response.ok) {
      return { available: false };
    }
    const payload = await response.json().catch(() => ({})) as { available?: unknown };
    return { available: Boolean(payload.available) };
  } catch {
    return { available: false };
  }
};

app.get("/api/stt/available", async (c) => c.json(await fetchSttAvailability()));
app.get("/api/stt/check-available", async (c) => c.json(await fetchSttAvailability()));

app.post("/api/stt/token", async (c) => {
  const sttProxyUrl = resolveSttProxyUrl();
  const baseHeaders = buildSttProxyHeaders();
  if (!sttProxyUrl || !baseHeaders) {
    return c.json({ error: "STT proxy not configured" }, 503);
  }

  const body = await c.req.json<{ durationSecs?: number }>().catch(() => ({}));
  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Type": "application/json",
  };

  try {
    const response = await fetch(`${sttProxyUrl}/token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ durationSecs: body.durationSecs }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `STT token request failed (${response.status})`;
      return c.json({ error }, response.status as 400);
    }
    return c.json(payload);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// ─── Usage Logs ──────────────────────────────────────────────────────────────

app.get("/api/usage", (c) => {
  const ownerId = c.req.query("ownerId") || "local";
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const rows = rawQuery(
    "SELECT * FROM usage_logs WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
    [ownerId, limit],
  );
  return c.json(rows);
});

// ─── Commands ────────────────────────────────────────────────────────────────

app.get("/api/commands", (c) => {
  const enabledOnly = c.req.query("enabledOnly") !== "false";
  if (enabledOnly) {
    return c.json(query("commands", { where: { enabled: 1 }, orderBy: "updated_at", order: "DESC" }));
  }
  return c.json(query("commands", { orderBy: "updated_at", order: "DESC" }));
});

// ─── Threads ─────────────────────────────────────────────────────────────────

app.get("/api/threads", (c) => {
  const conversationId = c.req.query("conversationId");
  if (!conversationId) return c.json({ error: "conversationId required" }, 400);
  const rows = query("threads", {
    where: { conversation_id: conversationId },
    orderBy: "last_used_at",
    order: "DESC",
  });
  return c.json(rows);
});

// ─── Synthesis (Pre-Login Onboarding) ────────────────────────────────────────

app.post("/api/synthesize", async (c) => {
  if (!runtimeConfig) {
    return c.json({ error: "Runtime not initialized" }, 503);
  }

  const body = await c.req.json<{ formattedSignals: string }>();
  if (!body?.formattedSignals) {
    return c.json({ error: "formattedSignals required" }, 400);
  }

  // Forward to Stella AI Proxy for LLM calls
  const proxyUrl = runtimeConfig.proxyUrl;
  if (!proxyUrl) {
    return c.json({ error: "AI proxy not configured" }, 503);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (runtimeConfig.authToken) {
    headers["Authorization"] = `Bearer ${runtimeConfig.authToken}`;
  } else {
    headers["X-Device-ID"] = runtimeConfig.deviceId;
  }

  try {
    const response = await fetch(`${proxyUrl}/api/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ formattedSignals: body.formattedSignals }),
    });

    if (!response.ok) {
      return c.json({ error: `Synthesis proxy error: ${response.status}` }, response.status as 400);
    }

    const result = await response.json();
    return c.json(result);
  } catch (error) {
    logError("Synthesis failed:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.post("/api/select-default-skills", async (c) => {
  if (!runtimeConfig) {
    return c.json({ error: "Runtime not initialized" }, 503);
  }

  const body = await c.req.json<{ coreMemory: string; availableSkills: string[] }>();
  if (!body?.coreMemory) {
    return c.json({ error: "coreMemory required" }, 400);
  }

  const proxyUrl = runtimeConfig.proxyUrl;
  if (!proxyUrl) {
    return c.json({ error: "AI proxy not configured" }, 503);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (runtimeConfig.authToken) {
    headers["Authorization"] = `Bearer ${runtimeConfig.authToken}`;
  } else {
    headers["X-Device-ID"] = runtimeConfig.deviceId;
  }

  try {
    // Use the proxy to call the LLM for skill selection
    const response = await fetch(`${proxyUrl}/api/ai/proxy`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stream: false,
        agentType: "suggestions",
        messages: [{
          role: "user",
          content: `Given this user profile:\n${body.coreMemory}\n\nSelect the most relevant skills from this list: ${body.availableSkills.join(", ")}\n\nReturn a JSON array of skill IDs to enable. Only select skills clearly useful for this user.`,
        }],
      }),
    });

    if (!response.ok) {
      return c.json({ selectedSkills: [] });
    }

    const result = await response.json() as { text?: string };
    try {
      const selected = JSON.parse(result.text || "[]");
      return c.json({ selectedSkills: Array.isArray(selected) ? selected : [] });
    } catch {
      return c.json({ selectedSkills: [] });
    }
  } catch (error) {
    logError("Skill selection failed:", error);
    return c.json({ selectedSkills: [] });
  }
});

// ─── Reset ───────────────────────────────────────────────────────────────────

app.post("/api/reset", (c) => {
  const db = getDb();
  rawRun(
    `UPDATE _sync_state
        SET dirty = 1, synced_at = NULL
      WHERE table_name IN (
        'events',
        'tasks',
        'threads',
        'thread_messages',
        'memories',
        'memory_extraction_batches',
        'canvas_states',
        'conversations',
        'usage_logs'
      )`,
  );
  db.exec(`
    DELETE FROM events;
    DELETE FROM tasks;
    DELETE FROM threads;
    DELETE FROM thread_messages;
    DELETE FROM memories;
    DELETE FROM memory_extraction_batches;
    DELETE FROM canvas_states;
    DELETE FROM conversations;
    DELETE FROM usage_logs;
  `);
  return c.json({ ok: true });
});

// ─── Math helpers ────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseDataUrl(dataUrl: string): { mimeType: string; size: number } | null {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1];
  const base64 = match[2].replace(/\s+/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const size = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return { mimeType, size };
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

let server: ReturnType<typeof serve> | null = null;

export const DEFAULT_PORT = 9714;

export function startLocalServer(port: number = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      // Ensure DB is initialized
      getDb();

      server = serve({
        fetch: app.fetch,
        port,
      }, (info) => {
        log(`Local server listening on http://localhost:${info.port}`);
        resolve(info.port);
      });
    } catch (err) {
      logError("Failed to start local server:", err);
      reject(err);
    }
  });
}

export function stopLocalServer(): void {
  if (server) {
    (server as unknown as Server).close();
    server = null;
    log("Local server stopped");
  }
  closeDb();
}

// Export for direct use in agent runtime
export {
  broadcastSSE,
  broadcastGlobal,
  app,
};

