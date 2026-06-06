/**
 * Skill usage telemetry — the sidecar that drives skill lifecycle.
 *
 * Stella keeps skills as plain markdown directories under
 * `${stellaHome}/skills/<id>/`. This module records lightweight, advisory
 * telemetry for each skill in a single sidecar file `skills/.usage.json`,
 * keyed by skill id. The sidecar is deliberately kept OUT of `SKILL.md` so a
 * skill stays merge-friendly and user-editable — telemetry never touches the
 * artifact the reconcile (`bundled-sync.ts`) hashes.
 *
 * Design (mirrors the battle-tested shape from hermes-agent's skill_usage):
 *   - One JSON map `{ [skillId]: SkillUsageRecord }`. A corrupt or missing file
 *     reads as `{}` rather than throwing — telemetry must never break a skill
 *     read or a boot.
 *   - Writes are atomic (tmp + rename) and `0600`, and serialized in-process so
 *     concurrent subagent reads can't interleave a torn write.
 *   - "Opening a skill is using it": a read of any file under `skills/<id>/`
 *     bumps `useCount` / `lastUsedAt`. There is no separate view/use split.
 *
 * This file is the DATA layer only. The aging/archival policy that consumes
 * these records lives in `skill-lifecycle.ts`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const SKILL_STATE = {
  ACTIVE: "active",
  STALE: "stale",
  ARCHIVED: "archived",
} as const;

export type SkillState = (typeof SKILL_STATE)[keyof typeof SKILL_STATE];

/** Who first authored the skill, used as a lifecycle eligibility gate. */
export type SkillProvenance = "bundled" | "agent" | "user";

export interface SkillUsageRecord {
  /**
   * Provenance gate. `bundled` skills are owned by the reconcile loop and are
   * never auto-archived; `agent` / `user` skills are curator-managed. Mirrors
   * hermes' `created_by` gate so automation only ages what it (or the user via
   * the agent) created — never a shipped default.
   */
  createdBy: SkillProvenance;
  useCount: number;
  lastUsedAt: string | null;
  patchCount: number;
  lastPatchedAt: string | null;
  createdAt: string;
  state: SkillState;
  /** User opt-out from auto transitions. Orthogonal to `state`. */
  pinned: boolean;
  archivedAt: string | null;
}

export type SkillUsageMap = Record<string, SkillUsageRecord>;

const USAGE_FILENAME = ".usage.json";
const USAGE_FILE_MODE = 0o600;

const nowIso = (): string => new Date().toISOString();

export const createEmptyRecord = (
  createdBy: SkillProvenance = "agent",
  createdAt: string = nowIso(),
): SkillUsageRecord => ({
  createdBy,
  useCount: 0,
  lastUsedAt: null,
  patchCount: 0,
  lastPatchedAt: null,
  createdAt,
  state: SKILL_STATE.ACTIVE,
  pinned: false,
  archivedAt: null,
});

const isSkillState = (value: unknown): value is SkillState =>
  value === SKILL_STATE.ACTIVE ||
  value === SKILL_STATE.STALE ||
  value === SKILL_STATE.ARCHIVED;

const isProvenance = (value: unknown): value is SkillProvenance =>
  value === "bundled" || value === "agent" || value === "user";

const asIsoOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

/**
 * Coerce an arbitrary parsed value into a well-formed record. Unknown/missing
 * fields fall back to safe defaults so a partially-written or hand-edited
 * sidecar never throws downstream.
 */
const coerceRecord = (value: unknown): SkillUsageRecord => {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    createdBy: isProvenance(raw.createdBy) ? raw.createdBy : "agent",
    useCount: asCount(raw.useCount),
    lastUsedAt: asIsoOrNull(raw.lastUsedAt),
    patchCount: asCount(raw.patchCount),
    lastPatchedAt: asIsoOrNull(raw.lastPatchedAt),
    createdAt: asIsoOrNull(raw.createdAt) ?? nowIso(),
    state: isSkillState(raw.state) ? raw.state : SKILL_STATE.ACTIVE,
    pinned: raw.pinned === true,
    archivedAt: asIsoOrNull(raw.archivedAt),
  };
};

export const usageFilePath = (skillsDir: string): string =>
  path.join(skillsDir, USAGE_FILENAME);

/** Read the whole usage map. Missing or corrupt file → `{}` (never throws). */
export const loadSkillUsage = async (
  skillsDir: string,
): Promise<SkillUsageMap> => {
  let raw: string;
  try {
    raw = await fs.readFile(usageFilePath(skillsDir), "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const clean: SkillUsageMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      clean[id] = coerceRecord(value);
    }
  }
  return clean;
};

// In-process write serialization: many subagents can read skills concurrently
// (and each read bumps usage), so chain writes per skills-dir to avoid a
// read-modify-write race tearing the file. Atomic rename additionally protects
// the rare cross-process overlap (host boot pass vs. worker reads) from
// corruption — the loser of a race loses a counter bump, never the file.
const writeChains = new Map<string, Promise<void>>();

const atomicWrite = async (
  skillsDir: string,
  map: SkillUsageMap,
): Promise<void> => {
  const target = usageFilePath(skillsDir);
  const tmp = `${target}.tmp.${process.pid}`;
  const serialized = `${JSON.stringify(map, null, 2)}\n`;
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(tmp, serialized, {
    encoding: "utf-8",
    mode: USAGE_FILE_MODE,
  });
  await fs.rename(tmp, target);
  await fs.chmod(target, USAGE_FILE_MODE).catch(() => {});
};

/**
 * Serialize a read-modify-write against the sidecar. `mutate` receives the
 * current map and returns the next one (or void to mutate in place). Errors are
 * swallowed by callers that want fire-and-forget; this returns the promise so
 * the lifecycle pass can await a full rewrite.
 */
export const updateSkillUsage = (
  skillsDir: string,
  mutate: (map: SkillUsageMap) => SkillUsageMap | void,
): Promise<void> => {
  const prior = writeChains.get(skillsDir) ?? Promise.resolve();
  const next = prior
    .catch(() => {})
    .then(async () => {
      const map = await loadSkillUsage(skillsDir);
      const result = mutate(map) ?? map;
      await atomicWrite(skillsDir, result);
    });
  // Keep the chain alive but don't let a rejection poison the stored promise.
  writeChains.set(
    skillsDir,
    next.catch(() => {}),
  );
  return next;
};

/** Persist a full map (used by the lifecycle pass after a batch of transitions). */
export const saveSkillUsage = (
  skillsDir: string,
  map: SkillUsageMap,
): Promise<void> => updateSkillUsage(skillsDir, () => map);

/**
 * Record that a skill was used (its `SKILL.md` or a support file was read).
 * Fire-and-forget friendly: caller may ignore the returned promise. A used
 * skill that was `stale` is reactivated immediately so recall ordering and the
 * lifecycle clock both reflect the access.
 */
export const recordSkillUse = (
  skillsDir: string,
  skillId: string,
): Promise<void> =>
  updateSkillUsage(skillsDir, (map) => {
    const rec = map[skillId] ?? createEmptyRecord();
    rec.useCount += 1;
    rec.lastUsedAt = nowIso();
    if (rec.state === SKILL_STATE.STALE) {
      rec.state = SKILL_STATE.ACTIVE;
    }
    map[skillId] = rec;
  });

/** Record that a skill's content was edited (bumps the lifecycle anchor). */
export const recordSkillPatch = (
  skillsDir: string,
  skillId: string,
): Promise<void> =>
  updateSkillUsage(skillsDir, (map) => {
    const rec = map[skillId] ?? createEmptyRecord();
    rec.patchCount += 1;
    rec.lastPatchedAt = nowIso();
    if (rec.state === SKILL_STATE.STALE) {
      rec.state = SKILL_STATE.ACTIVE;
    }
    map[skillId] = rec;
  });

/** Pin / unpin a skill (pinned skills are never auto-staled or archived). */
export const setSkillPinned = (
  skillsDir: string,
  skillId: string,
  pinned: boolean,
): Promise<void> =>
  updateSkillUsage(skillsDir, (map) => {
    const rec = map[skillId] ?? createEmptyRecord();
    rec.pinned = pinned;
    map[skillId] = rec;
  });

/** The most recent real activity timestamp, or null if the skill is untouched. */
export const latestActivityAt = (rec: SkillUsageRecord): string | null => {
  const candidates = [rec.lastUsedAt, rec.lastPatchedAt].filter(
    (v): v is string => typeof v === "string",
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a >= b ? a : b));
};

/**
 * Map a resolved filesystem path to the skill id it belongs to, or null.
 * Matches any file under `${skillsDir}/<id>/...` (so reading `SKILL.md` or a
 * `references/*.md` both count). Dot-prefixed top-level entries (`.archive`,
 * `.usage.json`) are never treated as skills.
 */
export const skillIdForPath = (
  skillsDir: string,
  filePath: string,
): string | null => {
  const rel = path.relative(path.resolve(skillsDir), path.resolve(filePath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  const [first] = rel.split(path.sep);
  if (!first || first.startsWith(".")) {
    return null;
  }
  return first;
};
