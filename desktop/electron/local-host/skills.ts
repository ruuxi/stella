import type { ParsedSkill } from "./manifests.js";
import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";

export const loadSkillsFromHome = async (
  skillsPath: string,
  pluginSkills: ParsedSkill[],
): Promise<ParsedSkill[]> => {
  const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
  const localSkills: ParsedSkill[] = [];

  for (const filePath of localSkillFiles) {
    const skill = await parseSkillMarkdown(filePath, "local");
    if (skill) localSkills.push(skill);
  }

  // Prefer local skills when IDs collide.
  const byId = new Map<string, ParsedSkill>();
  for (const skill of pluginSkills) {
    byId.set(skill.id, skill);
  }
  for (const skill of localSkills) {
    byId.set(skill.id, skill);
  }

  return Array.from(byId.values());
};
