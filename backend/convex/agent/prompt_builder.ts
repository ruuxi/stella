import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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

const buildCategoryTree = (
  categories: Array<{ category: string; subcategory: string }>,
): string => {
  const grouped = new Map<string, string[]>();
  for (const c of categories) {
    const subs = grouped.get(c.category) ?? [];
    subs.push(c.subcategory);
    grouped.set(c.category, subs);
  }

  const lines: string[] = [];
  const entries = Array.from(grouped.entries());
  for (const [category, subcategories] of entries) {
    lines.push(`${category}/`);
    for (let i = 0; i < subcategories.length; i++) {
      const isLast = i === subcategories.length - 1;
      lines.push(`${isLast ? "└──" : "├──"} ${subcategories[i]}`);
    }
  }
  return lines.join("\n");
};

export const buildSystemPrompt = async (
  ctx: ActionCtx,
  agentType: string,
  options?: { ownerId?: string; conversationId?: Id<"conversations"> },
): Promise<PromptBuildResult> => {
  const agent = await ctx.runQuery(internal.agent.agents.getAgentConfigInternal, {
    agentType,
  });

  const skills = await ctx.runQuery(internal.data.skills.listEnabledSkillsInternal, {
    agentType,
  });

  const skillsSection = buildSkillsSection(
    skills.map((skill: { id: string; name: string; description: string; execution?: string; requiresSecrets?: string[]; publicIntegration?: boolean; secretMounts?: Record<string, unknown> }) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      execution: skill.execution,
      requiresSecrets: skill.requiresSecrets,
      publicIntegration: skill.publicIntegration,
      secretMounts: skill.secretMounts,
    })),
  );

  const systemParts = [agent.systemPrompt];
  if (skillsSection) {
    systemParts.push(skillsSection);
  }

  // Add CORE_MEMORY awareness for the general agent when trust level is basic or full
  if (agentType === "general" && options?.ownerId) {
    try {
      const trustLevel = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
        ownerId: options.ownerId,
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

  // Inject device status for orchestrator
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const deviceStatus = await ctx.runQuery(
        internal.agent.device_resolver.getDeviceStatus,
        { ownerId: options.ownerId },
      );
      const lines = ["# Device Status"];
      lines.push(
        `- Local device (desktop app): ${deviceStatus.localOnline ? "online" : "offline"}`,
      );
      if (deviceStatus.cloudAvailable) {
        lines.push(`- Remote machine: ${deviceStatus.cloudStatus}`);
      } else {
        lines.push("- Remote machine: not provisioned");
      }
      if (!deviceStatus.localOnline) {
        lines.push(
          "\nThe user's desktop is offline. You cannot access their local files, apps, or shell.",
        );
        if (!deviceStatus.cloudAvailable) {
          lines.push(
            "No remote machine is available. Use SpawnRemoteMachine if the user needs tool execution.",
          );
        }
      }
      systemParts.push(lines.join("\n"));
    } catch {
      // Device status query failed — skip
    }
  }

  // Inject category tree for orchestrator
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const categories = await ctx.runQuery(internal.data.memory.listCategories, {
        ownerId: options.ownerId,
      });
      if (categories.length > 0) {
        const tree = buildCategoryTree(
          categories as Array<{ category: string; subcategory: string; count: number }>,
        );
        systemParts.push(`# Memory Categories\n${tree}`);
      }
    } catch {
      // Category query failed — skip
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
    skillIds: skills.map((skill: { id: string }) => skill.id),
  };
};
