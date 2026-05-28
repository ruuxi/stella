import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reconcileBundledSkills } from "../../../../../runtime/kernel/home/skills-sync.js";

const roots = new Set<string>();

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(dir);
  return dir;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeSkillFile = async (
  root: string,
  skillId: string,
  rel: string,
  content: string,
) => {
  const full = path.join(root, skillId, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
};

const readManifest = async (homeSkillsDir: string) => {
  const raw = await readFile(
    path.join(homeSkillsDir, ".bundled-manifest.json"),
    "utf-8",
  );
  return JSON.parse(raw) as {
    version: number;
    skills: Record<string, string>;
  };
};

const skillFiles = async (
  homeSkillsDir: string,
  skillId: string,
): Promise<string[]> => {
  const walk = async (dir: string, prefix: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walk(full, rel)));
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  };
  return walk(path.join(homeSkillsDir, skillId), "");
};

describe("reconcileBundledSkills", () => {
  it("seeds every bundled skill into an empty home", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(bundled, "beta", "SKILL.md", "beta v1");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions.filter((a) => a.type === "seed")).toHaveLength(2);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v1");
    const manifest = await readManifest(home);
    expect(Object.keys(manifest.skills).sort()).toEqual(["alpha", "beta"]);
  });

  it("seeds only the current platform computer skill", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(
      bundled,
      "stella-computer-macos",
      "SKILL.md",
      "mac skill",
    );
    await writeSkillFile(
      bundled,
      "stella-computer-windows",
      "SKILL.md",
      "windows skill",
    );

    const report = await reconcileBundledSkills(bundled, home, {
      platform: "win32",
    });

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "seed", skillId: "alpha" }),
        expect.objectContaining({
          type: "seed",
          skillId: "stella-computer-windows",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "stella-computer-windows", "SKILL.md"), "utf-8"),
    ).resolves.toBe("windows skill");
    await expect(
      readFile(path.join(home, "stella-computer-macos", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
    const manifest = await readManifest(home);
    expect(Object.keys(manifest.skills).sort()).toEqual([
      "alpha",
      "stella-computer-windows",
    ]);
  });

  it("removes a previously tracked platform computer skill when the platform changes", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(
      bundled,
      "stella-computer-macos",
      "SKILL.md",
      "mac skill",
    );
    await writeSkillFile(
      bundled,
      "stella-computer-windows",
      "SKILL.md",
      "windows skill",
    );

    await reconcileBundledSkills(bundled, home, { platform: "darwin" });
    const report = await reconcileBundledSkills(bundled, home, {
      platform: "win32",
    });

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "seed",
          skillId: "stella-computer-windows",
        }),
        expect.objectContaining({
          type: "remove-obsolete",
          skillId: "stella-computer-macos",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "stella-computer-macos", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "stella-computer-windows", "SKILL.md"), "utf-8"),
    ).resolves.toBe("windows skill");
  });

  it("overwrites a home skill when its hash still matches the manifest", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // First boot: seed v1.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    // Second boot: bundle bumped to v2, user has not touched local copy.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", skillId: "alpha" }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v2");
  });

  it("preserves a skill the user has modified", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    // User edits their copy.
    await writeFile(
      path.join(home, "alpha", "SKILL.md"),
      "user edits",
      "utf-8",
    );

    // New bundled version arrives.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-user-modified",
        skillId: "alpha",
        reason: "diverged",
      }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user edits");

    // The user's modified skill must not be tracked in the manifest, or a
    // later revert would silently re-sync without their consent.
    const manifest = await readManifest(home);
    expect(manifest.skills.alpha).toBeUndefined();
  });

  it("deletes obsolete files inside an unmodified skill when the bundle removes them", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(
      bundled,
      "alpha",
      "templates/old.tmpl",
      "old template",
    );
    await reconcileBundledSkills(bundled, home);

    // Bundle drops the old template.
    await rm(path.join(bundled, "alpha", "templates"), {
      recursive: true,
      force: true,
    });
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", skillId: "alpha" }),
    ]);
    expect(await skillFiles(home, "alpha")).toEqual(["SKILL.md"]);
  });

  it("removes a skill that the bundle dropped entirely when the user hasn't modified it", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(bundled, "obsolete", "SKILL.md", "obsolete v1");
    await reconcileBundledSkills(bundled, home);

    await rm(path.join(bundled, "obsolete"), { recursive: true, force: true });

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "remove-obsolete",
          skillId: "obsolete",
        }),
      ]),
    );
    await expect(readdir(path.join(home, "obsolete"))).rejects.toThrow();
    const manifest = await readManifest(home);
    expect(manifest.skills.obsolete).toBeUndefined();
  });

  it("keeps a user-modified obsolete skill but stops tracking it", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "obsolete", "SKILL.md", "v1");
    await reconcileBundledSkills(bundled, home);

    await writeFile(
      path.join(home, "obsolete", "SKILL.md"),
      "user edits",
      "utf-8",
    );
    await rm(path.join(bundled, "obsolete"), { recursive: true, force: true });

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-obsolete-user-modified",
        skillId: "obsolete",
      }),
    ]);
    await expect(
      readFile(path.join(home, "obsolete", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user edits");
    const manifest = await readManifest(home);
    expect(manifest.skills.obsolete).toBeUndefined();
  });

  it("ignores user-authored skills with no bundled counterpart and no manifest entry", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    // User-authored skill that never came from the bundle.
    await writeSkillFile(home, "gmail", "SKILL.md", "user skill");

    const report = await reconcileBundledSkills(bundled, home);

    expect(report.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "seed", skillId: "alpha" }),
        expect.objectContaining({
          type: "ignore-user-skill",
          skillId: "gmail",
        }),
      ]),
    );
    await expect(
      readFile(path.join(home, "gmail", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user skill");
    const manifest = await readManifest(home);
    expect(manifest.skills.gmail).toBeUndefined();
  });

  it("never touches user-profile, even if it sits in the bundle", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "user-profile", "SKILL.md", "bundled");
    await writeSkillFile(home, "user-profile", "SKILL.md", "user-owned");

    const report = await reconcileBundledSkills(bundled, home);

    expect(
      report.actions.find((a) =>
        "skillId" in a ? a.skillId === "user-profile" : false,
      ),
    ).toBeUndefined();
    await expect(
      readFile(path.join(home, "user-profile", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user-owned");
  });

  it("treats a first-run identical home skill as adopted (next bundle bump syncs)", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // Simulate the legacy bootstrap: user already has alpha v1 locally and
    // the bundle still ships alpha v1 — but no manifest exists yet.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(home, "alpha", "SKILL.md", "alpha v1");

    let report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({ type: "adopt-identical", skillId: "alpha" }),
    ]);

    // Next boot: bundle bumps to v2. Because we adopted the hash, the user
    // is now considered "unmodified" and the update can proceed.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v2");
    report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({ type: "update", skillId: "alpha" }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("alpha v2");
  });

  it("on first run with no manifest, leaves a diverged local copy alone forever", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    // Legacy state: user has long-edited alpha to something other than the
    // current bundle. No manifest.
    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await writeSkillFile(home, "alpha", "SKILL.md", "user-edited");

    const report = await reconcileBundledSkills(bundled, home);
    expect(report.actions).toEqual([
      expect.objectContaining({
        type: "skip-user-modified",
        skillId: "alpha",
        reason: "no-manifest",
      }),
    ]);
    await expect(
      readFile(path.join(home, "alpha", "SKILL.md"), "utf-8"),
    ).resolves.toBe("user-edited");
    const manifest = await readManifest(home);
    expect(manifest.skills.alpha).toBeUndefined();
  });

  it("is a no-op when bundle and home already agree under a current manifest", async () => {
    const bundled = await tempDir("stella-bundled-");
    const home = await tempDir("stella-home-skills-");

    await writeSkillFile(bundled, "alpha", "SKILL.md", "alpha v1");
    await reconcileBundledSkills(bundled, home);

    const second = await reconcileBundledSkills(bundled, home);
    expect(second.actions).toEqual([]);
  });
});
