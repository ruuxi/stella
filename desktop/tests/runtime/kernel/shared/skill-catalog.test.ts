import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INLINE_SKILL_CATALOG_THRESHOLD,
  buildSkillCatalogPromptState,
  renderFullSkillCatalogBlock,
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

  it("ignores dot-prefixed lifecycle bookkeeping dirs", async () => {
    const stellaRoot = await createStellaRoot();
    await writeSkill(stellaRoot, "pdf", "Work with PDFs.");
    // Lifecycle artifacts that share the skills dir must never look like skills.
    await mkdir(path.join(stellaRoot, "skills", ".archive", "old-skill"), {
      recursive: true,
    });
    await writeFile(
      path.join(stellaRoot, "skills", ".archive", "old-skill", "SKILL.md"),
      "archived",
      "utf-8",
    );
    await writeFile(
      path.join(stellaRoot, "skills", ".usage.json"),
      "{}",
      "utf-8",
    );

    const state = await buildSkillCatalogPromptState(stellaRoot);
    expect(state.entries.map((entry) => entry.id)).toEqual(["pdf"]);
    expect(state.totalSkills).toBe(1);
    const block = await renderSkillCatalogBlock(stellaRoot);
    expect(block).not.toContain(".archive");
    expect(block).not.toContain("old-skill");
  });

  it("renders every skill inline above the threshold for Explore", async () => {
    const stellaRoot = await createStellaRoot();
    const count = INLINE_SKILL_CATALOG_THRESHOLD + 5;
    for (let i = 0; i < count; i += 1) {
      await writeSkill(
        stellaRoot,
        `skill-${String(i).padStart(3, "0")}`,
        `Does thing ${i}.`,
      );
    }

    // The budget-aware renderer degrades to a placeholder above the threshold.
    const placeholder = await renderSkillCatalogBlock(stellaRoot);
    expect(placeholder).toContain("over the inline limit");

    // Explore's renderer always inlines every entry instead.
    const full = await renderFullSkillCatalogBlock(stellaRoot);
    expect(full).not.toContain("over the inline limit");
    expect(full).toContain("`skill-000`");
    expect(full).toContain(`\`skill-${String(count - 1).padStart(3, "0")}\``);
    const entryLines = full
      .split("\n")
      .filter((line) => line.startsWith("- `skill-"));
    expect(entryLines).toHaveLength(count);
  });
});
