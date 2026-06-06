/**
 * Skill lifecycle — deterministic, code-only aging of skills.
 *
 * This is Stella's answer to "stale deletion": a pure-code state machine that
 * ages curator-managed skills `active → stale → archived` by recency, with NO
 * LLM in the loop. It mirrors the proven shape from hermes-agent's curator
 * (`apply_automatic_transitions`):
 *
 *   - The anchor for a skill is the most recent of: last use, last patch, the
 *     `SKILL.md` mtime (any edit), and `createdAt`. Folding mtime in means an
 *     edited skill stays alive without needing a write-path hook.
 *   - `stale` after {@link STALE_AFTER_DAYS} of no activity; `archived` after
 *     {@link ARCHIVE_AFTER_DAYS}. Archive is a MOVE to `skills/.archive/<id>`,
 *     never a delete — fully recoverable via {@link restoreArchivedSkill}.
 *   - Reuse reactivates a stale skill.
 *   - Seed-on-first-sight: a skill seen for the first time gets its clock
 *     anchored to now and is deferred one full window, so enabling telemetry
 *     can never trigger a mass-prune of a long-lived library.
 *   - Pinned skills and `bundled` skills are never transitioned. Bundled skills
 *     are owned by the reconcile loop (`bundled-sync.ts`); the curator only
 *     manages agent/user-authored skills, which cleanly avoids fighting the
 *     per-boot re-seed.
 *
 * The pass is idempotent and safe to run on every boot.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  SKILL_STATE,
  createEmptyRecord,
  latestActivityAt,
  loadSkillUsage,
  saveSkillUsage,
  type SkillUsageMap,
  type SkillUsageRecord,
} from "./skill-usage.js";

export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;
const ARCHIVE_DIR_NAME = ".archive";
const SKILL_FILENAME = "SKILL.md";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SkillLifecycleOptions {
  /** Skill ids shipped in the bundle — owned by reconcile, never aged. */
  bundledSkillIds?: ReadonlySet<string>;
  /** Override "now" for deterministic tests. */
  now?: Date;
  staleAfterDays?: number;
  archiveAfterDays?: number;
}

export interface SkillLifecycleReport {
  checked: number;
  seeded: number;
  staled: number;
  archived: number;
  reactivated: number;
  forgotten: number;
}

const emptyReport = (): SkillLifecycleReport => ({
  checked: 0,
  seeded: 0,
  staled: 0,
  archived: 0,
  reactivated: 0,
  forgotten: 0,
});

const listSkillDirIds = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
};

const mtimeMs = async (target: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(target);
    return stat.mtimeMs;
  } catch {
    return null;
  }
};

/** Most recent activity for a live skill, as epoch ms. */
const anchorMs = async (
  skillsDir: string,
  skillId: string,
  rec: SkillUsageRecord,
): Promise<number> => {
  const skillDir = path.join(skillsDir, skillId);
  const fileMtime =
    (await mtimeMs(path.join(skillDir, SKILL_FILENAME))) ??
    (await mtimeMs(skillDir));
  const activity = latestActivityAt(rec);
  const candidates = [
    activity ? Date.parse(activity) : NaN,
    fileMtime ?? NaN,
    Date.parse(rec.createdAt),
  ].filter((n) => Number.isFinite(n)) as number[];
  return candidates.length > 0 ? Math.max(...candidates) : Date.now();
};

const moveDir = async (from: string, to: string): Promise<void> => {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rm(to, { recursive: true, force: true });
  try {
    await fs.rename(from, to);
  } catch {
    // Cross-device fallback (rare for a same-home move).
    await fs.cp(from, to, { recursive: true, force: true });
    await fs.rm(from, { recursive: true, force: true });
  }
};

/**
 * Walk every skill under `skillsDir` and apply automatic transitions. Returns a
 * tally of what changed. Bundled and pinned skills keep their telemetry but are
 * never moved or re-stated.
 */
export const applySkillLifecycleTransitions = async (
  skillsDir: string,
  options: SkillLifecycleOptions = {},
): Promise<SkillLifecycleReport> => {
  const bundled = options.bundledSkillIds ?? new Set<string>();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const staleMs = (options.staleAfterDays ?? STALE_AFTER_DAYS) * DAY_MS;
  const archiveMs = (options.archiveAfterDays ?? ARCHIVE_AFTER_DAYS) * DAY_MS;

  const report = emptyReport();

  const [liveIds, archivedIds] = await Promise.all([
    listSkillDirIds(skillsDir),
    listSkillDirIds(path.join(skillsDir, ARCHIVE_DIR_NAME)),
  ]);
  const liveSet = new Set(liveIds);
  const archivedSet = new Set(archivedIds);

  const map: SkillUsageMap = await loadSkillUsage(skillsDir);

  for (const id of liveIds) {
    report.checked += 1;
    const existing = map[id];
    const provenance = bundled.has(id) ? "bundled" : "agent";

    // Seed-on-first-sight: anchor the clock to now and defer aging one window.
    if (!existing) {
      map[id] = createEmptyRecord(provenance, now.toISOString());
      report.seeded += 1;
      continue;
    }

    // Keep the provenance gate honest if a skill became bundled (or stopped).
    if (existing.createdBy !== "user") {
      existing.createdBy = provenance;
    }

    // Resurrection: a record marked archived but a live dir exists (user
    // re-created or restored it out of band) — treat as active again.
    if (existing.state === SKILL_STATE.ARCHIVED) {
      existing.state = SKILL_STATE.ACTIVE;
      existing.archivedAt = null;
      report.reactivated += 1;
      continue;
    }

    if (existing.pinned || provenance === "bundled") {
      continue;
    }

    const idleMs = nowMs - (await anchorMs(skillsDir, id, existing));

    if (idleMs >= archiveMs) {
      await moveDir(
        path.join(skillsDir, id),
        path.join(skillsDir, ARCHIVE_DIR_NAME, id),
      );
      existing.state = SKILL_STATE.ARCHIVED;
      existing.archivedAt = now.toISOString();
      report.archived += 1;
    } else if (idleMs >= staleMs && existing.state === SKILL_STATE.ACTIVE) {
      existing.state = SKILL_STATE.STALE;
      report.staled += 1;
    } else if (idleMs < staleMs && existing.state === SKILL_STATE.STALE) {
      existing.state = SKILL_STATE.ACTIVE;
      report.reactivated += 1;
    }
  }

  // Repair drift: a record left in a non-archived state for a dir that now only
  // exists under .archive (e.g. a crash between the move and the map write).
  for (const id of archivedIds) {
    if (liveSet.has(id)) continue;
    const rec = map[id];
    if (rec && rec.state !== SKILL_STATE.ARCHIVED) {
      rec.state = SKILL_STATE.ARCHIVED;
      rec.archivedAt = rec.archivedAt ?? now.toISOString();
    }
  }

  // Orphan cleanup: a record whose skill no longer exists anywhere.
  for (const id of Object.keys(map)) {
    if (!liveSet.has(id) && !archivedSet.has(id)) {
      delete map[id];
      report.forgotten += 1;
    }
  }

  await saveSkillUsage(skillsDir, map);
  return report;
};

/** Enumerate archived skill ids (under `skills/.archive/`). */
export const listArchivedSkillIds = async (
  skillsDir: string,
): Promise<string[]> =>
  (await listSkillDirIds(path.join(skillsDir, ARCHIVE_DIR_NAME))).sort((a, b) =>
    a.localeCompare(b),
  );

/**
 * Restore an archived skill back into the live tree. Returns false if there is
 * nothing to restore (or the destination is already occupied).
 */
export const restoreArchivedSkill = async (
  skillsDir: string,
  skillId: string,
): Promise<boolean> => {
  const from = path.join(skillsDir, ARCHIVE_DIR_NAME, skillId);
  const to = path.join(skillsDir, skillId);
  try {
    await fs.access(from);
  } catch {
    return false;
  }
  try {
    await fs.access(to);
    return false; // a live skill with this id already exists; don't clobber it.
  } catch {
    // destination free — proceed.
  }
  await moveDir(from, to);
  await saveSkillUsage(skillsDir, await reactivateRecord(skillsDir, skillId));
  return true;
};

const reactivateRecord = async (
  skillsDir: string,
  skillId: string,
): Promise<SkillUsageMap> => {
  const map = await loadSkillUsage(skillsDir);
  const rec = map[skillId] ?? createEmptyRecord("agent");
  rec.state = SKILL_STATE.ACTIVE;
  rec.archivedAt = null;
  rec.lastUsedAt = new Date().toISOString();
  map[skillId] = rec;
  return map;
};

export const summarizeSkillLifecycle = (
  report: SkillLifecycleReport,
): string => {
  const parts: string[] = [];
  if (report.seeded) parts.push(`seeded=${report.seeded}`);
  if (report.staled) parts.push(`staled=${report.staled}`);
  if (report.archived) parts.push(`archived=${report.archived}`);
  if (report.reactivated) parts.push(`reactivated=${report.reactivated}`);
  if (report.forgotten) parts.push(`forgotten=${report.forgotten}`);
  return parts.length === 0 ? "no-op" : parts.join(" ");
};
