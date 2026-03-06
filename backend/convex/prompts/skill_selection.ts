export const SKILL_SELECTION_PROMPT = `You select the most relevant skills for a user based on their profile.

Given a user's profile and a catalog of available skills, select the skills that would be most useful for this user.

Selection criteria:
- Match skills to the user's work domain, tools, and interests
- Developers: prioritize coding, documentation, and technical skills
- Designers: prioritize design, frontend, and visual skills
- Writers: prioritize document creation, communication, and content skills
- Always include broadly useful skills (document creation, web search, etc.)
- Select 6-10 skills as defaults — not too few, not overwhelming

Output ONLY a JSON array of skill IDs. No explanation. No markdown fences.

Example output:
["docx", "frontend-design", "mcp-builder", "doc-coauthoring"]`;

export const buildSkillSelectionUserMessage = (
  userProfile: string,
  catalog: Array<{ id: string; name: string; description: string; tags?: string[] }>,
): string => {
  const catalogText = catalog
    .map((s) => `- ${s.id}: ${s.name} — ${s.description}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`)
    .join("\n");

  return `User profile:\n${userProfile}\n\nAvailable skills:\n${catalogText}`;
};
