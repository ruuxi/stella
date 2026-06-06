import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_STATE,
  latestActivityAt,
  loadSkillUsage,
  recordSkillPatch,
  recordSkillUse,
  setSkillPinned,
  skillIdForPath,
  usageFilePath,
} from "../../../../../runtime/kernel/home/skill-usage.js";

const roots = new Set<string>();

const makeSkillsDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-skill-usage-"));
  roots.add(root);
  const skillsDir = path.join(root, "skills");
  await mkdir(skillsDir, { recursive: true });
  return skillsDir;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("skill-usage sidecar", () => {
  it("returns an empty map for a missing or corrupt sidecar", async () => {
    const skillsDir = await makeSkillsDir();
    expect(await loadSkillUsage(skillsDir)).toEqual({});

    await writeFile(usageFilePath(skillsDir), "{ not valid json ", "utf-8");
    expect(await loadSkillUsage(skillsDir)).toEqual({});

    await writeFile(usageFilePath(skillsDir), "[1,2,3]", "utf-8");
    expect(await loadSkillUsage(skillsDir)).toEqual({});
  });

  it("records use, creating the record on first sight", async () => {
    const skillsDir = await makeSkillsDir();
    await recordSkillUse(skillsDir, "pdf");
    await recordSkillUse(skillsDir, "pdf");

    const map = await loadSkillUsage(skillsDir);
    expect(map.pdf.useCount).toBe(2);
    expect(map.pdf.lastUsedAt).toBeTruthy();
    expect(map.pdf.state).toBe(SKILL_STATE.ACTIVE);
  });

  it("reactivates a stale skill on use", async () => {
    const skillsDir = await makeSkillsDir();
    await recordSkillUse(skillsDir, "pdf");
    // Force the record to stale, then use it again.
    let map = await loadSkillUsage(skillsDir);
    map.pdf.state = SKILL_STATE.STALE;
    await writeFile(usageFilePath(skillsDir), JSON.stringify(map), "utf-8");

    await recordSkillUse(skillsDir, "pdf");
    map = await loadSkillUsage(skillsDir);
    expect(map.pdf.state).toBe(SKILL_STATE.ACTIVE);
  });

  it("tracks patches and pin state independently", async () => {
    const skillsDir = await makeSkillsDir();
    await recordSkillPatch(skillsDir, "pdf");
    await setSkillPinned(skillsDir, "pdf", true);

    const map = await loadSkillUsage(skillsDir);
    expect(map.pdf.patchCount).toBe(1);
    expect(map.pdf.lastPatchedAt).toBeTruthy();
    expect(map.pdf.pinned).toBe(true);
  });

  it("serializes concurrent writes without losing bumps", async () => {
    const skillsDir = await makeSkillsDir();
    await Promise.all(
      Array.from({ length: 25 }, () => recordSkillUse(skillsDir, "pdf")),
    );
    const map = await loadSkillUsage(skillsDir);
    expect(map.pdf.useCount).toBe(25);
  });

  it("writes the sidecar with 0600 permissions", async () => {
    const skillsDir = await makeSkillsDir();
    await recordSkillUse(skillsDir, "pdf");
    if (process.platform !== "win32") {
      const { mode } = await (
        await import("node:fs/promises")
      ).stat(usageFilePath(skillsDir));
      expect(mode & 0o777).toBe(0o600);
    }
  });

  describe("latestActivityAt", () => {
    it("returns the most recent of use/patch, or null when untouched", () => {
      expect(
        latestActivityAt({
          createdBy: "agent",
          useCount: 0,
          lastUsedAt: null,
          patchCount: 0,
          lastPatchedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          state: SKILL_STATE.ACTIVE,
          pinned: false,
          archivedAt: null,
        }),
      ).toBeNull();

      expect(
        latestActivityAt({
          createdBy: "agent",
          useCount: 1,
          lastUsedAt: "2026-02-01T00:00:00.000Z",
          patchCount: 1,
          lastPatchedAt: "2026-03-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          state: SKILL_STATE.ACTIVE,
          pinned: false,
          archivedAt: null,
        }),
      ).toBe("2026-03-01T00:00:00.000Z");
    });
  });

  describe("skillIdForPath", () => {
    it("maps files under a skill dir to the skill id", () => {
      const skillsDir = "/home/.stella/skills";
      expect(
        skillIdForPath(skillsDir, "/home/.stella/skills/pdf/SKILL.md"),
      ).toBe("pdf");
      expect(
        skillIdForPath(skillsDir, "/home/.stella/skills/pdf/references/x.md"),
      ).toBe("pdf");
    });

    it("returns null for non-skill paths and dot-dirs", () => {
      const skillsDir = "/home/.stella/skills";
      expect(
        skillIdForPath(skillsDir, "/home/.stella/memories/MEMORY.md"),
      ).toBeNull();
      expect(
        skillIdForPath(skillsDir, "/home/.stella/skills/.usage.json"),
      ).toBeNull();
      expect(
        skillIdForPath(skillsDir, "/home/.stella/skills/.archive/old/SKILL.md"),
      ).toBeNull();
      expect(skillIdForPath(skillsDir, "/etc/passwd")).toBeNull();
    });
  });
});
