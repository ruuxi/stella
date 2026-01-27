import type { ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";

export type PromptBuildResult = {
  systemPrompt: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
};

const buildSkillsSection = (
  skills: Array<{ id: string; name: string; description: string; filePath?: string }>,
) => {
  if (skills.length === 0) return "";

  const entries = skills.map((skill) => {
    const location = skill.filePath?.trim() || "unknown";
    const description = skill.description?.trim() || "Skill instructions.";
    return [
      `  <skill id="${skill.id}" name="${skill.name}" location="${location}">`,
      `    <description>${description}</description>`,
      "  </skill>",
    ].join("\n");
  });

  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    "- If exactly one skill clearly applies: read its SKILL.md at <location> with `Read`, then follow it.",
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
};

export const buildSystemPrompt = async (
  ctx: ActionCtx,
  agentType: string,
): Promise<PromptBuildResult> => {
  const agent = await ctx.runQuery(api.agents.getAgentConfig, {
    agentType,
  });

  const skills = await ctx.runQuery(api.skills.listEnabledSkills, {
    agentType,
  });

  const skillsSection = buildSkillsSection(
    skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    })),
  );

  const systemParts = [agent.systemPrompt];
  if (skillsSection) {
    systemParts.push(skillsSection);
  }

  const maxTaskDepthValue = Number(agent.maxTaskDepth ?? 2);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue) && maxTaskDepthValue > 0
    ? Math.floor(maxTaskDepthValue)
    : 2;

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    toolsAllowlist: agent.toolsAllowlist ?? undefined,
    maxTaskDepth,
    defaultSkills: agent.defaultSkills ?? [],
    skillIds: skills.map((skill) => skill.id),
  };
};
