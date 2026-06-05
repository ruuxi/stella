import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "../shared/private-fs.js";

/**
 * Hash-history reconciliation of bundled skills into Stella home.
 *
 * Stella ships a default skill catalogue at
 * `${stellaRoot}/runtime/home-seed/skills/`.
 * Users carry their own copy at `${stellaHome}/skills/`. The first-launch
 * bootstrap used to seed the home copy once and never touch it again, so
 * shipped skill updates (new docs, deleted templates, renamed scripts)
 * sat permanently shadowed by whatever version each user first booted
 * against.
 *
 * This module replaces that one-shot seed with a per-skill reconciliation:
 *
 *   - Each skill (`<id>/` directory) is hashed as a single unit. If the
 *     user has touched any file inside it, the whole skill is treated as
 *     user-owned and left alone.
 *   - A manifest at `<stellaHome>/skills/.bundled-manifest.json` records,
 *     for every skill we previously seeded, the hash we wrote. Next boot
 *     we know: same hash → safe to overwrite with the new bundled version;
 *     different hash → user diverged, hands off.
 *   - Skills in `<stellaHome>/skills/` that have no bundled counterpart
 *     and no manifest entry (e.g. user-authored skills) are ignored.
 *   - `<stellaHome>/skills/user-profile/` is excluded from the entire
 *     pipeline — it's intrinsically user-owned onboarding memory.
 */

const MANIFEST_FILENAME = ".bundled-manifest.json";
const USER_PROFILE_SKILL_ID = "user-profile";
const MANIFEST_VERSION = 1 as const;
const PLATFORM_SKILL_IDS: Partial<Record<NodeJS.Platform, readonly string[]>> =
  {
    darwin: ["stella-computer-macos", "apple-reminders", "apple-notes"],
    win32: ["stella-computer-windows"],
  };
const PLATFORM_EXCLUSIVE_SKILL_IDS = new Set(
  Object.values(PLATFORM_SKILL_IDS).flat(),
);

type SkillId = string;
type Sha256Hex = string;

type BundledManifest = {
  version: typeof MANIFEST_VERSION;
  skills: Record<SkillId, Sha256Hex>;
};

type SkillsSyncOptions = {
  platform?: NodeJS.Platform;
};

export type SkillsSyncAction =
  | { type: "seed"; skillId: SkillId; bundledHash: Sha256Hex }
  | { type: "update"; skillId: SkillId; bundledHash: Sha256Hex }
  | {
      type: "skip-user-modified";
      skillId: SkillId;
      reason: "diverged" | "no-manifest";
    }
  | { type: "adopt-identical"; skillId: SkillId; bundledHash: Sha256Hex }
  | { type: "remove-obsolete"; skillId: SkillId }
  | { type: "skip-obsolete-user-modified"; skillId: SkillId }
  | { type: "ignore-user-skill"; skillId: SkillId };

export type SkillsSyncReport = {
  actions: SkillsSyncAction[];
};

const isSkillIdValid = (entry: string): boolean => {
  if (!entry) return false;
  if (entry.startsWith(".")) return false;
  if (entry === USER_PROFILE_SKILL_ID) return false;
  return true;
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const listSkillIds = async (skillsDir: string): Promise<SkillId[]> => {
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSkillIdValid(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const isBundledSkillIncludedForPlatform = (
  skillId: SkillId,
  platform: NodeJS.Platform,
): boolean => {
  if (!PLATFORM_EXCLUSIVE_SKILL_IDS.has(skillId)) {
    return true;
  }
  return PLATFORM_SKILL_IDS[platform]?.includes(skillId) === true;
};

/**
 * Walk a skill directory and return every file path relative to the skill
 * root, sorted, for deterministic hashing. Symlinks are intentionally not
 * followed — bundled skills are plain files.
 */
const listSkillFilesRelative = async (
  skillDir: string,
  prefix = "",
): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(skillDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(skillDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSkillFilesRelative(full, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
};

const hashSkillDirectory = async (
  skillDir: string,
): Promise<Sha256Hex | null> => {
  if (!(await pathExists(skillDir))) return null;
  const files = await listSkillFilesRelative(skillDir);
  const hash = createHash("sha256");
  for (const rel of files) {
    const content = await fs.readFile(path.join(skillDir, rel));
    // `\0` between path + content + entry boundary avoids cross-file
    // ambiguities (e.g. "ab" + "c" vs "a" + "bc"). UTF-8 path is fine
    // because we control the bundled tree.
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const removeDirectory = async (dir: string): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true });
};

const copyDirectory = async (src: string, dest: string): Promise<void> => {
  await ensurePrivateDir(path.dirname(dest));
  await fs.cp(src, dest, { recursive: true, force: true });
};

const readManifest = async (
  manifestPath: string,
): Promise<BundledManifest | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === MANIFEST_VERSION &&
      typeof (parsed as { skills?: unknown }).skills === "object" &&
      (parsed as { skills?: unknown }).skills !== null
    ) {
      const skills = (parsed as { skills: Record<string, unknown> }).skills;
      const clean: Record<SkillId, Sha256Hex> = {};
      for (const [id, hash] of Object.entries(skills)) {
        if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) {
          clean[id] = hash;
        }
      }
      return { version: MANIFEST_VERSION, skills: clean };
    }
  } catch {
    // Corrupt manifest — fall through to null and rebuild conservatively.
  }
  return null;
};

const writeManifest = async (
  manifestPath: string,
  manifest: BundledManifest,
): Promise<void> => {
  await ensurePrivateDir(path.dirname(manifestPath));
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const tempPath = `${manifestPath}.tmp`;
  await fs.writeFile(tempPath, serialized, "utf-8");
  await fs.rename(tempPath, manifestPath);
};

/**
 * Reconcile bundled skills into a Stella home skills tree.
 *
 * Returns a report of every decision made so the caller can log it (the
 * desktop bootstrap surfaces a single summary line per launch).
 */
export const reconcileBundledSkills = async (
  bundledSkillsDir: string,
  homeSkillsDir: string,
  options: SkillsSyncOptions = {},
): Promise<SkillsSyncReport> => {
  await ensurePrivateDir(homeSkillsDir);

  const manifestPath = path.join(homeSkillsDir, MANIFEST_FILENAME);
  const manifest =
    (await readManifest(manifestPath)) ??
    ({ version: MANIFEST_VERSION, skills: {} } as BundledManifest);

  const platform = options.platform ?? process.platform;
  const bundledIds = (await listSkillIds(bundledSkillsDir)).filter((skillId) =>
    isBundledSkillIncludedForPlatform(skillId, platform),
  );
  const homeIds = await listSkillIds(homeSkillsDir);

  const actions: SkillsSyncAction[] = [];
  const nextSkills: Record<SkillId, Sha256Hex> = {};

  // 1. Reconcile every bundled skill against home + manifest.
  for (const skillId of bundledIds) {
    const bundledHash = await hashSkillDirectory(
      path.join(bundledSkillsDir, skillId),
    );
    if (!bundledHash) continue;

    const homeHash = await hashSkillDirectory(
      path.join(homeSkillsDir, skillId),
    );
    const recordedHash = manifest.skills[skillId];

    if (homeHash === null) {
      // Skill is new (or was deleted locally). Seed it.
      await copyDirectory(
        path.join(bundledSkillsDir, skillId),
        path.join(homeSkillsDir, skillId),
      );
      nextSkills[skillId] = bundledHash;
      actions.push({ type: "seed", skillId, bundledHash });
      continue;
    }

    if (homeHash === bundledHash) {
      // Already up to date. Make sure the manifest tracks it so a future
      // user edit is detected.
      nextSkills[skillId] = bundledHash;
      if (recordedHash !== bundledHash) {
        actions.push({ type: "adopt-identical", skillId, bundledHash });
      }
      continue;
    }

    if (recordedHash !== undefined && recordedHash === homeHash) {
      // Bundled changed, user hasn't touched it. Replace.
      await removeDirectory(path.join(homeSkillsDir, skillId));
      await copyDirectory(
        path.join(bundledSkillsDir, skillId),
        path.join(homeSkillsDir, skillId),
      );
      nextSkills[skillId] = bundledHash;
      actions.push({ type: "update", skillId, bundledHash });
      continue;
    }

    // User has diverged (or first run with no manifest entry). Leave the
    // local copy untouched and stop tracking — never overwrite user edits.
    actions.push({
      type: "skip-user-modified",
      skillId,
      reason: recordedHash === undefined ? "no-manifest" : "diverged",
    });
  }

  // 2. Handle skills the bundle no longer ships.
  const bundledIdSet = new Set(bundledIds);
  for (const skillId of homeIds) {
    if (bundledIdSet.has(skillId)) continue;
    const recordedHash = manifest.skills[skillId];
    if (recordedHash === undefined) {
      // Never bundled by us → user-owned (e.g. user-authored skills).
      // Leave it alone and don't carry it in the manifest.
      actions.push({ type: "ignore-user-skill", skillId });
      continue;
    }
    const homeHash = await hashSkillDirectory(
      path.join(homeSkillsDir, skillId),
    );
    if (homeHash !== null && homeHash === recordedHash) {
      // Bundled removed it and user hasn't touched it. Clean up.
      await removeDirectory(path.join(homeSkillsDir, skillId));
      actions.push({ type: "remove-obsolete", skillId });
    } else {
      // User customized an obsolete bundled skill. Leave it.
      actions.push({ type: "skip-obsolete-user-modified", skillId });
    }
  }

  await writeManifest(manifestPath, {
    version: MANIFEST_VERSION,
    skills: nextSkills,
  });

  return { actions };
};

export const summarizeSkillsSync = (report: SkillsSyncReport): string => {
  const tally = {
    seeded: 0,
    updated: 0,
    adopted: 0,
    preserved: 0,
    removed: 0,
    preservedObsolete: 0,
    ignored: 0,
  };
  for (const action of report.actions) {
    switch (action.type) {
      case "seed":
        tally.seeded += 1;
        break;
      case "update":
        tally.updated += 1;
        break;
      case "adopt-identical":
        tally.adopted += 1;
        break;
      case "skip-user-modified":
        tally.preserved += 1;
        break;
      case "remove-obsolete":
        tally.removed += 1;
        break;
      case "skip-obsolete-user-modified":
        tally.preservedObsolete += 1;
        break;
      case "ignore-user-skill":
        tally.ignored += 1;
        break;
    }
  }
  const parts: string[] = [];
  if (tally.seeded) parts.push(`seeded=${tally.seeded}`);
  if (tally.updated) parts.push(`updated=${tally.updated}`);
  if (tally.adopted) parts.push(`adopted=${tally.adopted}`);
  if (tally.preserved) parts.push(`preserved=${tally.preserved}`);
  if (tally.removed) parts.push(`removed=${tally.removed}`);
  if (tally.preservedObsolete)
    parts.push(`preservedObsolete=${tally.preservedObsolete}`);
  if (tally.ignored) parts.push(`ignored=${tally.ignored}`);
  return parts.length === 0 ? "no-op" : parts.join(" ");
};
