/**
 * Local memory system — embeddings via AI proxy, vector search in JS, storage in SQLite.
 * Ported from backend/convex/data/memory.ts
 */

import { rawQuery, rawRun, insert, update, markSyncRowsDirty } from "../db";

const RECALL_MIN_SCORE = 0.7;
const RECALL_TOP_K = 10;
const DEDUP_THRESHOLD = 0.9;
const MAX_MEMORIES_PER_OWNER = 500;
const DECAY_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

type MemoryRow = {
  id: string;
  owner_id: string;
  content: string;
  embedding: string | number[] | null;
  accessed_at: number;
  created_at: number;
};

export type RecalledMemory = {
  id: string;
  content: string;
  score: number;
  accessed_at: number;
};

// ─── Math ────────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(val: string | number[] | null): number[] | null {
  if (!val) return null;
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return null; }
}

// ─── Embedding ───────────────────────────────────────────────────────────────

export type EmbedFunction = (text: string) => Promise<number[]>;

/**
 * Create an embed function that calls the Stella AI Proxy.
 * Falls back to null embeddings if proxy is unreachable.
 */
export function createProxyEmbedder(
  proxyUrl: string,
  auth: { jwt?: string; deviceId?: string },
): EmbedFunction {
  return async (text: string): Promise<number[]> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth.jwt) {
      headers["Authorization"] = `Bearer ${auth.jwt}`;
    } else if (auth.deviceId) {
      headers["X-Device-ID"] = auth.deviceId;
    }

    const response = await fetch(`${proxyUrl}/api/ai/embed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, model: "alibaba/qwen3-embedding-8b" }),
    });

    if (!response.ok) {
      throw new Error(`Embed request failed: ${response.status}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  };
}

// ─── Recall ──────────────────────────────────────────────────────────────────

/**
 * Recall memories via brute-force cosine similarity.
 * With 500-memory cap, this is sub-millisecond.
 */
export function recallMemories(
  ownerId: string,
  queryEmbedding: number[],
): RecalledMemory[] {
  const allMemories = rawQuery<MemoryRow>(
    "SELECT * FROM memories WHERE owner_id = ? AND embedding IS NOT NULL",
    [ownerId],
  );

  const now = Date.now();
  const scored = allMemories
    .map((mem) => {
      const memVec = parseEmbedding(mem.embedding);
      if (!memVec || memVec.length !== queryEmbedding.length) {
        return { ...mem, score: 0 };
      }
      return { ...mem, score: cosineSimilarity(queryEmbedding, memVec) };
    })
    .filter((m) => m.score > RECALL_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, RECALL_TOP_K);

  // Update accessed_at
  for (const mem of scored) {
    update("memories", { accessed_at: now }, { id: mem.id });
  }

  return scored.map((m) => ({
    id: m.id,
    content: m.content,
    score: m.score,
    accessed_at: now,
  }));
}

// ─── Save ────────────────────────────────────────────────────────────────────

/**
 * Save a memory with embedding-based dedup.
 * Returns the memory id if saved, or the existing id if deduplicated.
 */
export function saveMemory(
  ownerId: string,
  content: string,
  embedding: number[] | null,
  conversationId?: string,
): { id: string; deduplicated: boolean } {
  // Dedup check
  if (embedding) {
    const existing = rawQuery<MemoryRow>(
      "SELECT id, embedding FROM memories WHERE owner_id = ? AND embedding IS NOT NULL",
      [ownerId],
    );

    for (const mem of existing) {
      const memVec = parseEmbedding(mem.embedding);
      if (!memVec) continue;
      if (cosineSimilarity(embedding, memVec) > DEDUP_THRESHOLD) {
        // Update accessed_at on the existing memory
        update("memories", { accessed_at: Date.now() }, { id: mem.id });
        return { id: mem.id, deduplicated: true };
      }
    }
  }

  // Enforce growth limits
  const countResult = rawQuery<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM memories WHERE owner_id = ?",
    [ownerId],
  );
  if ((countResult[0]?.cnt ?? 0) >= MAX_MEMORIES_PER_OWNER) {
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

  const now = Date.now();
  const id = insert("memories", {
    owner_id: ownerId,
    conversation_id: conversationId || null,
    content,
    embedding: embedding ? JSON.stringify(embedding) : null,
    accessed_at: now,
    created_at: now,
  });

  return { id, deduplicated: false };
}

// ─── Decay ───────────────────────────────────────────────────────────────────

/** Delete memories not accessed in 30 days */
export function decayOldMemories(): number {
  const cutoff = Date.now() - DECAY_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = rawQuery<{ id: string }>(
    "SELECT id FROM memories WHERE accessed_at < ?",
    [cutoff],
  );
  const result = rawRun(
    "DELETE FROM memories WHERE accessed_at < ?",
    [cutoff],
  );
  if (toDelete.length > 0) {
    markSyncRowsDirty("memories", toDelete.map((row) => row.id));
  }
  return result.changes;
}
