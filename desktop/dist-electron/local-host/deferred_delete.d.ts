export declare const DEFERRED_DELETE_RETENTION_MS: number;
export type DeferredDeleteRecord = {
    id: string;
    source: string;
    originalPath: string;
    trashPath: string;
    trashedAt: number;
    purgeAfter: number;
    requestId?: string;
    agentType?: string;
    conversationId?: string;
};
export type TrashPathsOptions = {
    source: string;
    cwd?: string;
    force?: boolean;
    stellaHome?: string;
    requestId?: string;
    agentType?: string;
    conversationId?: string;
};
export type TrashPathsResult = {
    trashed: DeferredDeleteRecord[];
    skipped: string[];
    errors: Array<{
        path: string;
        error: string;
    }>;
};
export type DeferredDeleteSweepResult = {
    checked: number;
    purged: number;
    skipped: number;
    errors: string[];
};
type DeferredDeletePaths = {
    stellaHome: string;
    baseDir: string;
    itemsDir: string;
    trashDir: string;
};
export declare const getDeferredDeletePaths: (stellaHomeOverride?: string) => DeferredDeletePaths;
export declare const trashPathsForDeferredDelete: (targets: string[], options: TrashPathsOptions) => Promise<TrashPathsResult>;
export declare const trashPathForDeferredDelete: (target: string, options: TrashPathsOptions) => Promise<DeferredDeleteRecord | null>;
export declare const purgeExpiredDeferredDeletes: (options?: {
    stellaHome?: string;
    now?: number;
}) => Promise<DeferredDeleteSweepResult>;
export {};
