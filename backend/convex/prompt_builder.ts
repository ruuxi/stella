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
  skills: Array<{
    id: string;
    name: string;
    description: string;
    execution?: string;
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: Record<string, unknown>;
  }>,
) => {
  if (skills.length === 0) return "";

  const lines = skills.map((skill) => {
    const tags: string[] = [];
    if (skill.publicIntegration) tags.push("public");
    if (skill.requiresSecrets && skill.requiresSecrets.length > 0) tags.push("requires credentials");
    if (skill.execution === "backend") tags.push("backend-only");
    if (skill.execution === "device") tags.push("device-only");
    if (skill.secretMounts) tags.push("has secret mounts");
    const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    return `- **${skill.name}** (${skill.id}): ${skill.description}${suffix}`;
  });

  return [
    "# Skills",
    "Use the ActivateSkill tool to load a skill's full instructions before using it.",
    "",
    ...lines,
  ].join("\n");
};

export const buildSystemPrompt = async (
  ctx: ActionCtx,
  agentType: string,
  options?: { ownerId?: string },
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
      execution: (skill as { execution?: string }).execution,
      requiresSecrets: (skill as { requiresSecrets?: string[] }).requiresSecrets,
      publicIntegration: (skill as { publicIntegration?: boolean }).publicIntegration,
      secretMounts: (skill as { secretMounts?: Record<string, unknown> }).secretMounts,
    })),
  );

  const systemParts = [agent.systemPrompt];
  if (skillsSection) {
    systemParts.push(skillsSection);
  }

  // Add CORE_MEMORY awareness for the general agent when trust level is basic or full
  if (agentType === "general" && options?.ownerId) {
    try {
      const trustLevel = await ctx.runQuery(api.preferences.getPreference, {
        key: "trust_level",
      });
      if (trustLevel === "basic" || trustLevel === "full") {
        systemParts.push(
          "If ~/.stella/state/CORE_MEMORY.MD exists, read it at the start of new conversations to personalize your responses. This contains the user's discovered context profile.",
        );
      }
    } catch {
      // Preference not found or auth issue — skip
    }
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
