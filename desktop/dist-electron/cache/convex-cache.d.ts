type ConvexQueryRunner = <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T | null>;
export type CachedEvent = {
    _id: string;
    timestamp: number;
    type: string;
    deviceId?: string;
    requestId?: string;
    targetDeviceId?: string;
    payload?: Record<string, unknown>;
};
export type CachedTask = {
    _id: string;
    status: string;
    agentType?: string;
    description?: string;
    parentTaskId?: string;
    result?: string;
    error?: string;
    updatedAt: number;
};
export type CachedThread = {
    _id: string;
    title: string;
    agentType: string;
    status: string;
    createdAt: number;
    lastActiveAt: number;
};
export type CachedMemoryCategory = {
    category: string;
    subcategory: string;
    count: number;
    updatedAt: number;
};
export declare class ConvexCacheStore {
    private readonly runQuery;
    private readonly db;
    constructor(dbPath: string, runQuery: ConvexQueryRunner);
    close(): void;
    resetAll(): void;
    getConversationEvents(conversationId: string, limit?: number): CachedEvent[];
    syncConversationEvents(conversationId: string, options?: {
        limit?: number;
        syncLimit?: number;
    }): Promise<CachedEvent[]>;
    getTasks(conversationId: string, limit?: number): CachedTask[];
    syncTasks(conversationId: string, options?: {
        limit?: number;
        syncLimit?: number;
    }): Promise<CachedTask[]>;
    getThreads(conversationId: string, limit?: number): CachedThread[];
    syncThreads(conversationId: string, options?: {
        limit?: number;
    }): Promise<CachedThread[]>;
    getMemoryCategories(ownerId?: string, limit?: number): CachedMemoryCategory[];
    syncMemoryCategories(ownerId?: string, options?: {
        limit?: number;
    }): Promise<CachedMemoryCategory[]>;
    private migrate;
    private getMetaNumber;
    private setMetaNumber;
    private fetchRecentEvents;
    private fetchEventsSince;
    private upsertEvents;
    private pruneConversationEvents;
    private fetchRecentTasks;
    private fetchTasksSince;
    private upsertTasks;
    private pruneFinishedTasks;
    private fetchActiveThreads;
    private replaceThreads;
    private fetchMemoryCategories;
    private replaceMemoryCategories;
}
export {};
