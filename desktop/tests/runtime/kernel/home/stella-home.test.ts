import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureStellaDataDirSeeded } from "../../../../../runtime/kernel/home/stella-home.js";

const roots = new Set<string>();

const createTempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("ensureStellaDataDirSeeded", () => {
  it("seeds only bundled defaults into Stella home", async () => {
    const stellaAppDir = await createTempDir("stella-seed-root-");
    const stellaDataDir = await createTempDir("stella-home-");
    const seedRoot = path.join(stellaAppDir, "runtime", "home-seed");

    await mkdir(path.join(seedRoot, "skills", "stella-desktop"), {
      recursive: true,
    });
    await mkdir(path.join(seedRoot, "outputs"), { recursive: true });
    await mkdir(path.join(seedRoot, "memories"), { recursive: true });
    await mkdir(
      path.join(
        stellaAppDir,
        "runtime/extensions/stella-runtime/agent-metadata",
      ),
      { recursive: true },
    );
    await writeFile(path.join(seedRoot, "DREAM.md"), "seed dream");
    await writeFile(
      path.join(seedRoot, "skills", "stella-desktop", "SKILL.md"),
      "desktop skill",
    );
    await writeFile(path.join(seedRoot, "outputs", "README.md"), "outputs");
    await writeFile(path.join(seedRoot, "preferences.json"), "{}");
    await writeFile(path.join(seedRoot, "memories", "MEMORY.md"), "old memory");
    await writeFile(
      path.join(
        stellaAppDir,
        "runtime/extensions/stella-runtime/agent-metadata/general.md",
      ),
      "---\nname: General\ndescription: general\ntools: spawn_agent, send_input, pause_agent\nmaxAgentDepth: 2\n---\n\nbundled general\n",
    );

    const result = await ensureStellaDataDirSeeded(stellaAppDir, stellaDataDir);

    expect(result.promptResolution).toBe("unavailable");
    // With no resolvable prompt manifest nothing writes agent bodies into home;
    // bundled agent metadata stays in the app dir and is read from there.
    await expect(
      readFile(path.join(stellaDataDir, "agents", "general.md"), "utf-8"),
    ).rejects.toThrow();

    await expect(
      readFile(path.join(stellaDataDir, "registry.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(stellaDataDir, "skills", "stella-desktop", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("desktop skill");
    await expect(
      readFile(path.join(stellaDataDir, "preferences.json"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(stellaDataDir, "memories", "MEMORY.md"), "utf-8"),
    ).rejects.toThrow();
  });
});
