export const SKILL_METADATA_PROMPT = `You generate metadata for AI skill files.

Given a skill's markdown content and directory name, output ONLY valid JSON with these fields:

{"id": "<directory name>", "name": "<Human readable title>", "description": "<1-2 sentence summary>", "agentTypes": ["general-purpose"]}

Rules:
- id: Use the directory name exactly as given (it's already kebab-case)
- name: Convert the id to Title Case (e.g., "code-review" becomes "Code Review")
- description: Summarize what the skill does in 1-2 sentences, focusing on what it enables
- agentTypes: Always use ["general-purpose"] unless the content clearly targets a specific type

Output ONLY the JSON object. No markdown code fences. No explanation.`;

export const buildSkillMetadataUserMessage = (
  skillDirName: string,
  markdown: string,
): string => {
  // Truncate markdown to avoid token limits (keep first ~4000 chars)
  const truncated = markdown.length > 4000 ? markdown.slice(0, 4000) + "\n..." : markdown;
  return `Directory name: ${skillDirName}\n\nSkill content:\n${truncated}`;
};
