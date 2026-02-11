import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";
export const loadSkillsFromHome = async (skillsPath) => {
    const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
    const localSkills = [];
    for (const filePath of localSkillFiles) {
        const skill = await parseSkillMarkdown(filePath, "local");
        if (skill)
            localSkills.push(skill);
    }
    return localSkills;
};
