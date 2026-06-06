import {
  access,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applySkillLifecycleTransitions,
  listArchivedSkillIds,
  restoreArchivedSkill,
} from "../../../../../runtime/kernel/home/skill-lifecycle.js";
import {
  SKILL_STATE,
  loadSkillUsage,
  usageFilePath,
} from "../../../../../runtime/kernel/home/skill-usage.js";

const roots = new Set<string>();

const makeSkillsDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-skill-lifecycle-"));
  roots.add(root);
  const skillsDir = path.join(root, "skills");
  await mkdir(skillsDir, { recursive: true });
  return skillsDir;
};

const writeSkill = async (skillsDir: string, id: string, mtime?: Date) => {
  const dir = path.join(skillsDir, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, `# ${id}`, "utf-8");
  if (mtime) {
    await utimes(file, mtime, mtime);
    await utimes(dir, mtime, mtime);
  }
};

const seedUsage = async (
  skillsDir: string,
  records: Record<string, Record<string, unknown>>,
) => {
  await writeFile(usageFilePath(skillsDir), JSON.stringify(records), "utf-8");
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const iso = (d: Date) => d.toISOString();

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("applySkillLifecycleTransitions", () => {
  it("seeds an unseen skill and defers aging (no mass-prune)", async () => {
    const skillsDir = await makeSkillsDir();
    // Old on disk, but never seen by telemetry before.
    await writeSkill(skillsDir, "ancient", daysAgo(400));

    const report = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(report.seeded).toBe(1);
    expect(report.archived).toBe(0);
    expect(report.staled).toBe(0);

    const map = await loadSkillUsage(skillsDir);
    expect(map.ancient.state).toBe(SKILL_STATE.ACTIVE);
    expect(map.ancient.createdBy).toBe("agent");
    // Clock anchored to "now", so the dir survives.
    expect(await exists(path.join(skillsDir, "ancient"))).toBe(true);
  });

  it("marks an idle skill stale, then archives after the longer window", async () => {
    const skillsDir = await makeSkillsDir();
    await writeSkill(skillsDir, "rarely-used", daysAgo(40));
    await seedUsage(skillsDir, {
      "rarely-used": {
        createdBy: "agent",
        useCount: 1,
        lastUsedAt: iso(daysAgo(40)),
        createdAt: iso(daysAgo(120)),
        state: SKILL_STATE.ACTIVE,
        pinned: false,
      },
    });

    const staleReport = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(staleReport.staled).toBe(1);
    expect((await loadSkillUsage(skillsDir))["rarely-used"].state).toBe(
      SKILL_STATE.STALE,
    );

    // Now make it idle past the archive window.
    await writeSkill(skillsDir, "rarely-used", daysAgo(100));
    await seedUsage(skillsDir, {
      "rarely-used": {
        createdBy: "agent",
        useCount: 1,
        lastUsedAt: iso(daysAgo(100)),
        createdAt: iso(daysAgo(200)),
        state: SKILL_STATE.STALE,
        pinned: false,
      },
    });
    const archiveReport = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(archiveReport.archived).toBe(1);
    expect(await exists(path.join(skillsDir, "rarely-used"))).toBe(false);
    expect(await exists(path.join(skillsDir, ".archive", "rarely-used"))).toBe(
      true,
    );
    expect((await loadSkillUsage(skillsDir))["rarely-used"].state).toBe(
      SKILL_STATE.ARCHIVED,
    );
  });

  it("never archives bundled or pinned skills", async () => {
    const skillsDir = await makeSkillsDir();
    await writeSkill(skillsDir, "stella-desktop", daysAgo(300));
    await writeSkill(skillsDir, "my-pinned", daysAgo(300));
    await seedUsage(skillsDir, {
      "stella-desktop": {
        createdBy: "bundled",
        createdAt: iso(daysAgo(400)),
        lastUsedAt: iso(daysAgo(300)),
        state: SKILL_STATE.ACTIVE,
        pinned: false,
      },
      "my-pinned": {
        createdBy: "agent",
        createdAt: iso(daysAgo(400)),
        lastUsedAt: iso(daysAgo(300)),
        state: SKILL_STATE.ACTIVE,
        pinned: true,
      },
    });

    const report = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
      bundledSkillIds: new Set(["stella-desktop"]),
    });
    expect(report.archived).toBe(0);
    expect(await exists(path.join(skillsDir, "stella-desktop"))).toBe(true);
    expect(await exists(path.join(skillsDir, "my-pinned"))).toBe(true);
  });

  it("reactivates a skill used again after going stale", async () => {
    const skillsDir = await makeSkillsDir();
    await writeSkill(skillsDir, "back-in-use", daysAgo(1));
    await seedUsage(skillsDir, {
      "back-in-use": {
        createdBy: "agent",
        useCount: 5,
        lastUsedAt: iso(daysAgo(1)),
        createdAt: iso(daysAgo(200)),
        state: SKILL_STATE.STALE,
        pinned: false,
      },
    });
    const report = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(report.reactivated).toBe(1);
    expect((await loadSkillUsage(skillsDir))["back-in-use"].state).toBe(
      SKILL_STATE.ACTIVE,
    );
  });

  it("forgets records whose skill directory no longer exists", async () => {
    const skillsDir = await makeSkillsDir();
    await seedUsage(skillsDir, {
      ghost: {
        createdBy: "agent",
        createdAt: iso(daysAgo(10)),
        state: SKILL_STATE.ACTIVE,
        pinned: false,
      },
    });
    const report = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(report.forgotten).toBe(1);
    expect((await loadSkillUsage(skillsDir)).ghost).toBeUndefined();
  });

  it("restores an archived skill back into the live tree", async () => {
    const skillsDir = await makeSkillsDir();
    await mkdir(path.join(skillsDir, ".archive", "revived"), {
      recursive: true,
    });
    await writeFile(
      path.join(skillsDir, ".archive", "revived", "SKILL.md"),
      "# revived",
      "utf-8",
    );
    await seedUsage(skillsDir, {
      revived: {
        createdBy: "agent",
        createdAt: iso(daysAgo(200)),
        state: SKILL_STATE.ARCHIVED,
        pinned: false,
        archivedAt: iso(daysAgo(5)),
      },
    });

    expect(await listArchivedSkillIds(skillsDir)).toEqual(["revived"]);
    expect(await restoreArchivedSkill(skillsDir, "revived")).toBe(true);
    expect(await exists(path.join(skillsDir, "revived", "SKILL.md"))).toBe(
      true,
    );
    expect(await exists(path.join(skillsDir, ".archive", "revived"))).toBe(
      false,
    );

    const map = await loadSkillUsage(skillsDir);
    expect(map.revived.state).toBe(SKILL_STATE.ACTIVE);
    expect(map.revived.archivedAt).toBeNull();
  });

  it("is idempotent across repeated boots", async () => {
    const skillsDir = await makeSkillsDir();
    await writeSkill(skillsDir, "pdf", daysAgo(2));
    const first = await applySkillLifecycleTransitions(skillsDir, { now: NOW });
    expect(first.seeded).toBe(1);
    const second = await applySkillLifecycleTransitions(skillsDir, {
      now: NOW,
    });
    expect(second.seeded).toBe(0);
    expect(second.archived).toBe(0);
    expect(second.staled).toBe(0);
  });
});
