import type { ParsedSkill } from "./manifests.js";
import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";

export const loadSkillsFromHome = async (
  skillsPath: string,
): Promise<ParsedSkill[]> => {
  const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
  const localSkills: ParsedSkill[] = [];

  for (const filePath of localSkillFiles) {
    const skill = await parseSkillMarkdown(filePath, "local");
    if (skill) localSkills.push(skill);
  }

  return localSkills;
};
