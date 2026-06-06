/**
 * Hash-history reconciliation of bundled skills into Stella home.
 *
 * Stella ships a default skill catalogue at
 * `${stellaRoot}/runtime/home-seed/skills/`. Users carry their own copy at
 * `${stellaHome}/skills/`. Each skill (`<id>/` directory) is reconciled as a
 * unit so shipped updates reach users who haven't edited that skill, while
 * local edits are preserved. The reconciliation algorithm itself lives in
 * `bundled-sync.ts` — this module just supplies the skill-specific policy
 * (directory units, platform gating, user-profile exclusion).
 */

import {
  createDirectoryEntryAdapter,
  reconcileBundledEntries,
  summarizeBundledSync,
  type BundledSyncReport,
} from "./bundled-sync.js";

const USER_PROFILE_SKILL_ID = "user-profile";
const PLATFORM_SKILL_IDS: Partial<Record<NodeJS.Platform, readonly string[]>> =
  {
    darwin: ["stella-computer-macos", "apple-reminders", "apple-notes"],
    win32: ["stella-computer-windows"],
  };
const PLATFORM_EXCLUSIVE_SKILL_IDS = new Set(
  Object.values(PLATFORM_SKILL_IDS).flat(),
);

type SkillsSyncOptions = {
  platform?: NodeJS.Platform;
};

export type SkillsSyncReport = BundledSyncReport;

const isBundledSkillIncludedForPlatform = (
  skillId: string,
  platform: NodeJS.Platform,
): boolean => {
  if (!PLATFORM_EXCLUSIVE_SKILL_IDS.has(skillId)) {
    return true;
  }
  return PLATFORM_SKILL_IDS[platform]?.includes(skillId) === true;
};

/**
 * Reconcile bundled skills into a Stella home skills tree. `user-profile` is
 * intrinsically user-owned onboarding memory and is excluded entirely.
 */
export const reconcileBundledSkills = async (
  bundledSkillsDir: string,
  homeSkillsDir: string,
  options: SkillsSyncOptions = {},
): Promise<SkillsSyncReport> => {
  const platform = options.platform ?? process.platform;
  return reconcileBundledEntries(
    bundledSkillsDir,
    homeSkillsDir,
    createDirectoryEntryAdapter((id) => id !== USER_PROFILE_SKILL_ID),
    {
      includeBundledId: (id) =>
        isBundledSkillIncludedForPlatform(id, platform),
      // Manifests seeded before the generic rename stored hashes under
      // `skills`; read them so already-installed users still get updates.
      legacyEntriesKey: "skills",
    },
  );
};

export const summarizeSkillsSync = summarizeBundledSync;
