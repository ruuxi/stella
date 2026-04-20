import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSkillCatalogPromptState,
  INLINE_SKILL_CATALOG_THRESHOLD,
  listSkillCatalogEntries,
  renderSkillCatalogBlock,
  shouldUseAutomaticSkillExplore,
} from "../../../../../runtime/kernel/exec/skill-catalog.js";

const tempRoots: string[] = [];

const createTempRoot = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-skill-catalog-"));
  mkdirSync(path.join(root, "state", "skills"), { recursive: true });
  tempRoots.push(root);
  return root;
};

const writeSkill = (
  root: string,
  skillId: string,
  docs: string,
  options?: { withProgram?: boolean },
): void => {
  const skillDir = path.join(root, "state", "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), docs, "utf-8");
  if (options?.withProgram) {
    const scriptsDir = path.join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      path.join(scriptsDir, "program.ts"),
      'console.log("hello");\n',
      "utf-8",
    );
  }
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("skill catalog", () => {
  it("renders an empty skills block gracefully", async () => {
    const root = createTempRoot();

    const block = await renderSkillCatalogBlock(root);

    expect(block).toContain("<skills>");
    expect(block).toContain("## Available skills");
    expect(block).toContain("No saved skills yet.");
    expect(block).toContain("## How to use skills");
  });

  it("includes name, description, path, and program presence for skill folders", async () => {
    const root = createTempRoot();
    writeSkill(
      root,
      "alpha",
      "---\nname: Alpha Skill\ndescription: Handles alpha tasks.\n---\n# Alpha\n",
    );
    writeSkill(
      root,
      "beta",
      "---\nname: Beta Skill\ndescription: Handles beta tasks.\n---\n# Beta\n",
      { withProgram: true },
    );

    const entries = await listSkillCatalogEntries(root);
    const block = await renderSkillCatalogBlock(root);

    expect(entries).toEqual([
      {
        id: "alpha",
        name: "Alpha Skill",
        description: "Handles alpha tasks.",
        path: "state/skills/alpha/SKILL.md",
        hasProgram: false,
      },
      {
        id: "beta",
        name: "Beta Skill",
        description: "Handles beta tasks.",
        path: "state/skills/beta/SKILL.md",
        hasProgram: true,
      },
    ]);
    expect(block).toContain("`alpha` — Handles alpha tasks. (path: state/skills/alpha/SKILL.md)");
    expect(block).toContain("`beta` — Handles beta tasks. (path: state/skills/beta/SKILL.md) Includes optional `scripts/program.ts`.");
  });

  it("falls back to the folder name when frontmatter is missing or invalid", async () => {
    const root = createTempRoot();
    writeSkill(root, "broken", "---\nname: [\n# Broken\n");

    const [entry] = await listSkillCatalogEntries(root);

    expect(entry).toMatchObject({
      id: "broken",
      name: "broken",
      description: "broken",
      path: "state/skills/broken/SKILL.md",
      hasProgram: false,
    });
  });

  it("parses loose name/description headers used by existing skills", async () => {
    const root = createTempRoot();
    writeSkill(
      root,
      "legacy",
      [
        "---",
        "",
        "## name: Legacy Skill",
        "",
        "description: Existing docs format still works.",
        "",
        "# Legacy",
        "",
      ].join("\n"),
    );

    const [entry] = await listSkillCatalogEntries(root);

    expect(entry).toMatchObject({
      id: "legacy",
      name: "Legacy Skill",
      description: "Existing docs format still works.",
    });
  });

  it("switches to placeholder mode once the skill count exceeds the inline threshold", async () => {
    const root = createTempRoot();
    for (let index = 0; index <= INLINE_SKILL_CATALOG_THRESHOLD; index += 1) {
      mkdirSync(path.join(root, "state", "skills", `skill-${index}`), {
        recursive: true,
      });
    }

    const state = await buildSkillCatalogPromptState(root);
    const block = await renderSkillCatalogBlock(root);
    const shouldAutoExplore = await shouldUseAutomaticSkillExplore(root);

    expect(state.mode).toBe("placeholder");
    expect(state.totalSkills).toBe(INLINE_SKILL_CATALOG_THRESHOLD + 1);
    expect(state.entries).toEqual([]);
    expect(block).toContain("full skill catalog is omitted");
    expect(block).toContain(`${INLINE_SKILL_CATALOG_THRESHOLD + 1} saved skills`);
    expect(shouldAutoExplore).toBe(true);
  });
});
