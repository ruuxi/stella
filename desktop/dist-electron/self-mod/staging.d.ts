/**
 * Staging directory management.
 * All staged files live under ~/.stella/mods/staging/{featureId}/
 * mirroring the frontend/src/ structure.
 */
export declare const getStagingRoot: () => string;
export declare const getModsRoot: () => string;
/**
 * Write a file to the staging directory for a feature.
 * relativePath should be relative to frontend/src/ (e.g., "components/Sidebar.tsx")
 */
export declare function stageFile(featureId: string, relativePath: string, content: string): Promise<void>;
/**
 * Read a staged file. Returns null if not staged.
 */
export declare function readStaged(featureId: string, relativePath: string): Promise<string | null>;
/**
 * List all staged files for a feature, returned as relative paths.
 */
export declare function listStagedFiles(featureId: string): Promise<string[]>;
/**
 * Remove staging directory for a feature.
 */
export declare function clearStaging(featureId: string): Promise<void>;
