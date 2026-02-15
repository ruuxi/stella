/**
 * Sync Manifest — hash-based dirty tracking for skill/agent sync.
 *
 * Persists content hashes in ~/.stella/state/sync_manifest.json so that
 * syncManifests() can skip DB writes when nothing has changed.
 */
import crypto from "crypto";
import path from "path";
import { loadJson, saveJson } from "./tools-utils.js";
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const MANIFEST_FILE = "sync_manifest.json";
const emptyManifest = () => ({
    version: 1,
    skills: {},
    agents: {},
});
export const loadSyncManifest = (statePath) => loadJson(path.join(statePath, MANIFEST_FILE), emptyManifest());
export const saveSyncManifest = (statePath, manifest) => saveJson(path.join(statePath, MANIFEST_FILE), manifest);
// ---------------------------------------------------------------------------
// Hash Computation
// ---------------------------------------------------------------------------
const hashObject = (obj) => crypto
    .createHash("sha256")
    .update(JSON.stringify(obj, Object.keys(obj).sort()))
    .digest("hex")
    .slice(0, 16);
export const computeSkillHash = (skill) => {
    // Exclude filePath — it's local-only and shouldn't affect sync
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { filePath: _, ...rest } = skill;
    return hashObject(rest);
};
export const computeAgentHash = (agent) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { filePath: _, ...rest } = agent;
    return hashObject(rest);
};
// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
export const diffSkills = (skills, manifest) => {
    const upsert = [];
    const currentIds = new Set();
    for (const skill of skills) {
        currentIds.add(skill.id);
        const hash = computeSkillHash(skill);
        const existing = manifest.skills[skill.id];
        if (!existing || existing.hash !== hash) {
            upsert.push(skill);
        }
    }
    const removeIds = [];
    for (const id of Object.keys(manifest.skills)) {
        if (!currentIds.has(id)) {
            removeIds.push(id);
        }
    }
    return { upsert, removeIds };
};
export const diffAgents = (agents, manifest) => {
    const upsert = [];
    const currentIds = new Set();
    for (const agent of agents) {
        currentIds.add(agent.id);
        const hash = computeAgentHash(agent);
        const existing = manifest.agents[agent.id];
        if (!existing || existing.hash !== hash) {
            upsert.push(agent);
        }
    }
    const removeIds = [];
    for (const id of Object.keys(manifest.agents)) {
        if (!currentIds.has(id)) {
            removeIds.push(id);
        }
    }
    return { upsert, removeIds };
};
// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
export const applyDiffToManifest = (manifest, skillsDiff, agentsDiff) => {
    const now = Date.now();
    const updated = {
        version: 1,
        skills: { ...manifest.skills },
        agents: { ...manifest.agents },
    };
    for (const skill of skillsDiff.upsert) {
        updated.skills[skill.id] = { hash: computeSkillHash(skill), syncedAt: now };
    }
    for (const id of skillsDiff.removeIds) {
        delete updated.skills[id];
    }
    for (const agent of agentsDiff.upsert) {
        updated.agents[agent.id] = {
            hash: computeAgentHash(agent),
            syncedAt: now,
        };
    }
    for (const id of agentsDiff.removeIds) {
        delete updated.agents[id];
    }
    return updated;
};
