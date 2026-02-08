/**
 * Snapshot/revert system.
 * Before each apply, backup originals to ~/.stella/mods/features/{featureId}/snapshots/{batchIndex}/
 */
export type SnapshotEntry = {
    batchIndex: number;
    files: string[];
    createdAt: number;
};
/**
 * Take a snapshot of the current source files before applying changes.
 * Copies each file from frontendRoot + relativePath into the snapshot dir.
 */
export declare function takeSnapshot(featureId: string, batchIndex: number, filePaths: string[], frontendRoot: string): Promise<void>;
/**
 * Restore a snapshot, copying files back to source.
 * For files marked as __new__ (didn't exist before), delete them from source.
 */
export declare function restoreSnapshot(featureId: string, batchIndex: number, frontendRoot: string): Promise<string[]>;
/**
 * List available revert points for a feature.
 */
export declare function listSnapshots(featureId: string): Promise<SnapshotEntry[]>;
