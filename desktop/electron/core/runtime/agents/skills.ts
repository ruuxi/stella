import type { ParsedSkill } from "./manifests.js";
import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";

export const isSkillEnabled = (skill: Pick<ParsedSkill, "enabled"> | null | undefined): boolean =>
  skill?.enabled !== false;

export const loadSkillsFromHome = async (
  ...skillsPaths: string[]
): Promise<ParsedSkill[]> => {
  const allSkills: ParsedSkill[] = [];
  const seenIds = new Set<string>();

  for (const skillsPath of skillsPaths) {
    const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
    for (const filePath of localSkillFiles) {
      const skill = await parseSkillMarkdown(filePath, "local");
      if (!skill) continue;
      if (!isSkillEnabled(skill)) continue;
      if (seenIds.has(skill.id)) continue;
      seenIds.add(skill.id);
      allSkills.push(skill);
    }
  }

  return allSkills;
};
