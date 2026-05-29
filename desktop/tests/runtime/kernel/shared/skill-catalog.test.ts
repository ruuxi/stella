import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSkillCatalogPromptState,
  renderSkillCatalogBlock,
} from "../../../../../runtime/kernel/shared/skill-catalog.js";

const roots = new Set<string>();

const createStellaRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-skill-catalog-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeSkill = async (
  stellaRoot: string,
  skillId: string,
  description: string,
) => {
  const skillDir = path.join(stellaRoot, "skills", skillId);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillId}`,
      `description: ${description}`,
      "---",
      "",
      `# ${skillId}`,
    ].join("\n"),
    "utf-8",
  );
};

describe("skill catalog", () => {
  it("omits configured skill ids from the prompt block", async () => {
    const stellaRoot = await createStellaRoot();
    await writeSkill(stellaRoot, "create-stella-app", "Create Stella apps.");
    await writeSkill(stellaRoot, "stella-browser", "Control browser tabs.");
    await writeSkill(stellaRoot, "pdf", "Work with PDFs.");

    const state = await buildSkillCatalogPromptState(stellaRoot, {
      omitSkillIds: ["stella-browser", "pdf"],
    });
    const block = await renderSkillCatalogBlock(stellaRoot, {
      omitSkillIds: ["stella-browser", "pdf"],
    });

    expect(state.totalSkills).toBe(1);
    expect(state.entries.map((entry) => entry.id)).toEqual([
      "create-stella-app",
    ]);
    expect(block).toContain("`create-stella-app`");
    expect(block).not.toContain("stella-browser");
    expect(block).not.toContain("pdf");
  });
});
