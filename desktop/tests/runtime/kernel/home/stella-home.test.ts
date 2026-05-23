import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureStellaHomeSeeded } from "../../../../../runtime/kernel/home/stella-home.js";

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

describe("ensureStellaHomeSeeded", () => {
  it("seeds only bundled defaults into Stella home", async () => {
    const stellaRoot = await createTempDir("stella-seed-root-");
    const stellaHome = await createTempDir("stella-home-");
    const seedRoot = path.join(stellaRoot, "state");

    await mkdir(path.join(seedRoot, "skills", "stella-desktop"), {
      recursive: true,
    });
    await mkdir(path.join(seedRoot, "outputs"), { recursive: true });
    await mkdir(path.join(seedRoot, "memories"), { recursive: true });
    await writeFile(path.join(seedRoot, "registry.md"), "seed registry");
    await writeFile(path.join(seedRoot, "DREAM.md"), "seed dream");
    await writeFile(
      path.join(seedRoot, "skills", "stella-desktop", "SKILL.md"),
      "desktop skill",
    );
    await writeFile(path.join(seedRoot, "outputs", "README.md"), "outputs");
    await writeFile(path.join(seedRoot, "preferences.json"), "{}");
    await writeFile(path.join(seedRoot, "memories", "MEMORY.md"), "old memory");

    await ensureStellaHomeSeeded(stellaRoot, stellaHome);

    await expect(readFile(path.join(stellaHome, "registry.md"), "utf-8"))
      .resolves.toBe("seed registry");
    await expect(
      readFile(
        path.join(stellaHome, "skills", "stella-desktop", "SKILL.md"),
        "utf-8",
      ),
    ).resolves.toBe("desktop skill");
    await expect(readFile(path.join(stellaHome, "preferences.json"), "utf-8"))
      .rejects.toThrow();
    await expect(
      readFile(path.join(stellaHome, "memories", "MEMORY.md"), "utf-8"),
    ).rejects.toThrow();
  });
});
