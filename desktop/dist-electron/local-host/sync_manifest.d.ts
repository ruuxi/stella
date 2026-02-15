/**
 * Sync Manifest — hash-based dirty tracking for skill/agent sync.
 *
 * Persists content hashes in ~/.stella/state/sync_manifest.json so that
 * syncManifests() can skip DB writes when nothing has changed.
 */
import type { ParsedSkill } from "./manifests.js";
import type { ParsedAgent } from "./manifests.js";
type ManifestEntry = {
    hash: string;
    syncedAt: number;
};
export type SyncManifest = {
    version: 1;
    skills: Record<string, ManifestEntry>;
    agents: Record<string, ManifestEntry>;
};
export type DiffResult<T> = {
    upsert: T[];
    removeIds: string[];
};
export declare const loadSyncManifest: (statePath: string) => Promise<SyncManifest>;
export declare const saveSyncManifest: (statePath: string, manifest: SyncManifest) => Promise<void>;
export declare const computeSkillHash: (skill: ParsedSkill) => string;
export declare const computeAgentHash: (agent: ParsedAgent) => string;
export declare const diffSkills: (skills: ParsedSkill[], manifest: SyncManifest) => DiffResult<ParsedSkill>;
export declare const diffAgents: (agents: ParsedAgent[], manifest: SyncManifest) => DiffResult<ParsedAgent>;
export declare const applyDiffToManifest: (manifest: SyncManifest, skillsDiff: DiffResult<ParsedSkill>, agentsDiff: DiffResult<ParsedAgent>) => SyncManifest;
export {};
