import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

export type PromptBuildResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
};

const SKILLS_DISABLED_AGENT_TYPES = new Set(["explore", "memory"]);
const MAX_ACTIVE_THREADS_IN_PROMPT = 12;

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
    return `- **${skill.name}** (${skill.id}): ${skill.description}${suffix} Activate skill.`;
  });

  return [
    "# Skills",
    "Skills are listed by name and description only. Use ActivateSkill to load a skill's full instructions when needed.",
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
    ownerId: options?.ownerId,
  });

  const skills = SKILLS_DISABLED_AGENT_TYPES.has(agentType)
    ? []
    : await ctx.runQuery(internal.data.skills.listEnabledSkillsInternal, {
        agentType,
        ownerId: options?.ownerId,
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

  // Dynamic context — injected into last user message for prompt caching
  const dynamicParts: string[] = [];

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
      dynamicParts.push(lines.join("\n"));
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
        dynamicParts.push(`# Memory Categories\n${tree}`);
      }
    } catch {
      // Category query failed — skip
    }
  }

  // Inject active threads for orchestrator
  if (agentType === "orchestrator" && options?.conversationId) {
    try {
      const activeThreads = await ctx.runQuery(internal.data.threads.listActiveThreads, {
        conversationId: options.conversationId,
      });
      if (activeThreads.length > 0) {
        const visibleThreads = activeThreads.slice(0, MAX_ACTIVE_THREADS_IN_PROMPT);
        const lines = visibleThreads.map((t) => {
          const ageMs = Date.now() - t.lastUsedAt;
          const age = ageMs < 60_000 ? "just now"
            : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago`
            : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
            : `${Math.floor(ageMs / 86_400_000)}d ago`;
          return `- **${t.name}** (id: ${t._id}) — ${t.messageCount} msgs, last used ${age}`;
        });
        if (activeThreads.length > visibleThreads.length) {
          lines.push(
            `- ...and ${activeThreads.length - visibleThreads.length} more active thread(s). Use thread_name to reuse by name.`,
          );
        }
        dynamicParts.push(
          `# Active Threads\nContinue with thread_id, or create new with thread_name.\n${lines.join("\n")}`,
        );
      }
    } catch {
      // Thread query failed — skip
    }
  }

  // Inject core memory for orchestrator
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const coreMemories = await ctx.runQuery(internal.data.memory.getExistingMemories, {
        ownerId: options.ownerId,
        category: "core",
        subcategory: "identity",
      });
      if (coreMemories.length > 0) {
        const coreContent = coreMemories.map((m: { content: string }) => m.content).join("\n");
        dynamicParts.push(`# Core Memory\n${coreContent}`);
      }
    } catch {
      // Core memory query failed — skip
    }
  }

  const maxTaskDepthValue = Number(agent.maxTaskDepth ?? 2);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue) && maxTaskDepthValue > 0
    ? Math.floor(maxTaskDepthValue)
    : 2;

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    dynamicContext: dynamicParts.join("\n\n").trim(),
    toolsAllowlist: agent.toolsAllowlist ?? undefined,
    maxTaskDepth,
    defaultSkills: agent.defaultSkills ?? [],
    skillIds: skills.map((skill: { id: string }) => skill.id),
  };
};
