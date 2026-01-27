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
  skills: Array<{ id: string; name: string; markdown: string }>,
) => {
  if (skills.length === 0) return "";

  const blocks = skills
    .map((skill) => {
      const header = `## Skill: ${skill.name} (${skill.id})`;
      return `${header}\n${skill.markdown}`.trim();
    })
    .filter((block) => block.length > 0);

  if (blocks.length === 0) return "";

  return ["# Skills", ...blocks].join("\n\n");
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
    skills.map((skill) => ({ id: skill.id, name: skill.name, markdown: skill.markdown })),
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
