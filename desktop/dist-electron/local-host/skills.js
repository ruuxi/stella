import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";
export const loadSkillsFromHome = async (skillsPath, pluginSkills) => {
    const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
    const localSkills = [];
    for (const filePath of localSkillFiles) {
        const skill = await parseSkillMarkdown(filePath, "local");
        if (skill)
            localSkills.push(skill);
    }
    // Prefer local skills when IDs collide.
    const byId = new Map();
    for (const skill of pluginSkills) {
        byId.set(skill.id, skill);
    }
    for (const skill of localSkills) {
        byId.set(skill.id, skill);
    }
    return Array.from(byId.values());
};
