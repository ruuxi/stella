import type { ParsedSkill } from "./manifests.js";
import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";

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
      if (seenIds.has(skill.id)) continue;
      seenIds.add(skill.id);
      allSkills.push(skill);
    }
  }

  return allSkills;
};
