import { listMarkdownFiles, parseSkillMarkdown } from "./manifests.js";
import { validateSkillContent } from "./command_safety.js";
export const loadSkillsFromHome = async (skillsPath) => {
    const localSkillFiles = await listMarkdownFiles(skillsPath, "SKILL.md");
    const localSkills = [];
    for (const filePath of localSkillFiles) {
        const skill = await parseSkillMarkdown(filePath, "local");
        if (!skill)
            continue;
        // Safety check: validate skill content for unsafe patterns
        const validation = validateSkillContent(skill.markdown);
        if (!validation.safe) {
            const issues = validation.issues
                .map((issue) => `[${issue.category}] ${issue.description}`)
                .join(", ");
            console.warn(`[skills] Skipping skill "${skill.id}" from ${filePath}: unsafe patterns detected (${issues})`);
            continue;
        }
        localSkills.push(skill);
    }
    return localSkills;
};
