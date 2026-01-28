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
    markdown: string;
    execution?: string;
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: Record<string, unknown>;
  }>,
) => {
  if (skills.length === 0) return "";

  const blocks = skills
    .map((skill) => {
      const header = `## Skill: ${skill.name} (${skill.id})`;
      const notes: string[] = [];
      if (skill.publicIntegration) {
        notes.push("Public integration: no user API key required.");
      }
      if (skill.requiresSecrets && skill.requiresSecrets.length > 0) {
        notes.push(
          `Requires credential(s): ${skill.requiresSecrets.join(", ")}. Use RequestCredential if missing, then IntegrationRequest to use them.`,
        );
      }
      if (skill.execution === "backend") {
        notes.push("Execution: backend-only.");
      }
      if (skill.execution === "device") {
        notes.push("Execution: device-only.");
      }
      if (skill.secretMounts) {
        const mounts = skill.secretMounts;
        const env =
          mounts &&
          typeof mounts === "object" &&
          "env" in mounts &&
          mounts.env &&
          typeof mounts.env === "object"
            ? Object.keys(mounts.env as Record<string, unknown>)
            : [];
        const files =
          mounts &&
          typeof mounts === "object" &&
          "files" in mounts &&
          mounts.files &&
          typeof mounts.files === "object"
            ? Object.keys(mounts.files as Record<string, unknown>)
            : [];
        const mountParts: string[] = [];
        if (env.length > 0) {
          mountParts.push(`env: ${env.join(", ")}`);
        }
        if (files.length > 0) {
          mountParts.push(`files: ${files.join(", ")}`);
        }
        if (mountParts.length > 0) {
          notes.push(`Detected secret mounts (${mountParts.join("; ")}).`);
        }
        notes.push("Use SkillBash for local commands so secrets are mounted automatically.");
      }
      const notesBlock = notes.length > 0 ? `Note: ${notes.join(" ")}` : "";
      return [header, notesBlock, skill.markdown].filter(Boolean).join("\n").trim();
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
    skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      markdown: skill.markdown,
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
