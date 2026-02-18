/**
 * Local memory system — embeddings via AI proxy, vector search in JS, storage in SQLite.
 * Ported from backend/convex/data/memory.ts
 */
export type RecalledMemory = {
    id: string;
    content: string;
    score: number;
    accessed_at: number;
};
export type EmbedFunction = (text: string) => Promise<number[]>;
/**
 * Create an embed function that calls the Stella AI Proxy.
 * Falls back to null embeddings if proxy is unreachable.
 */
export declare function createProxyEmbedder(proxyUrl: string, auth: {
    jwt?: string;
    deviceId?: string;
}): EmbedFunction;
/**
 * Recall memories via brute-force cosine similarity.
 * With 500-memory cap, this is sub-millisecond.
 */
export declare function recallMemories(ownerId: string, queryEmbedding: number[]): RecalledMemory[];
/**
 * Save a memory with embedding-based dedup.
 * Returns the memory id if saved, or the existing id if deduplicated.
 */
export declare function saveMemory(ownerId: string, content: string, embedding: number[] | null, conversationId?: string): {
    id: string;
    deduplicated: boolean;
};
/** Delete memories not accessed in 30 days */
export declare function decayOldMemories(): number;
