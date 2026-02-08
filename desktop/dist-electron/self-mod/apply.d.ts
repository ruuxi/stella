/**
 * Atomic apply: staged changes -> source with rollback on failure.
 */
export type BatchResult = {
    batchIndex: number;
    files: string[];
    message?: string;
};
export type HistoryEntry = {
    batchIndex: number;
    message?: string;
    files: string[];
    appliedAt: number;
};
/**
 * Apply all staged files for a feature to the source directory.
 * 1. Snapshot current source versions (takeSnapshot)
 * 2. Materialize all staged files to temp files
 * 3. Move existing source files aside as backups
 * 4. Promote temp files into source paths
 * 5. Roll back fully if any step fails
 * 6. Record history + clear staging
 */
export declare function applyBatch(featureId: string, frontendRoot: string, message?: string): Promise<BatchResult>;
/**
 * Get the apply history for a feature.
 */
export declare function getHistory(featureId: string): Promise<HistoryEntry[]>;
/**
 * Remove the latest N history entries after a revert operation.
 */
export declare function removeLastHistoryEntries(featureId: string, count: number): Promise<HistoryEntry[]>;
