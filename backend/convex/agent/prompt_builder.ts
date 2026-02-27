import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { ConvexError, Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireUserId } from "../auth";
import { getModelConfig } from "./model";

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
type FetchAgentContextSharedArgs = {
  ownerId: string;
  conversationId: Id<"conversations">;
  agentType: string;
  runId: string;
  threadId?: Id<"threads">;
  maxHistoryMessages?: number;
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
    return `- **${skill.name}** (${skill.id}): ${skill.description}${suffix} Activate skill.`;
  });

  return [
    "# Skills",
    "Skills are listed by name and description only. Use ActivateSkill to load a skill's full instructions when needed.",
    "",
    ...lines,
  ].join("\n");
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

  // Inject active threads for orchestrator
  if (agentType === "orchestrator" && options?.conversationId && options.ownerId) {
    try {
      const activeThreads = await ctx.runQuery(internal.data.threads.listActiveThreads, {
        ownerId: options.ownerId,
        conversationId: options.conversationId,
      });
      const subagentThreads = activeThreads.filter((t: { name: string }) => t.name !== "Main");
      if (subagentThreads.length > 0) {
        const visibleThreads = subagentThreads.slice(0, MAX_ACTIVE_THREADS_IN_PROMPT);
        const lines = visibleThreads.map((t: { _id: string; name: string; messageCount: number; lastUsedAt: number }) => {
          const ageMs = Date.now() - t.lastUsedAt;
          const age = ageMs < 60_000 ? "just now"
            : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago`
            : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
            : `${Math.floor(ageMs / 86_400_000)}d ago`;
          return `- **${t.name}** (id: ${t._id}) — ${t.messageCount} msgs, last used ${age}`;
        });
        if (subagentThreads.length > visibleThreads.length) {
          lines.push(
            `- ...and ${subagentThreads.length - visibleThreads.length} more active thread(s). Use thread_name to reuse by name.`,
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

  // Inject expression style preference for orchestrator
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const style = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId: options.ownerId, key: "expression_style" },
      );
      if (style === "none") {
        dynamicParts.push("The user prefers responses without emoji.");
      } else if (style === "emoji") {
        dynamicParts.push("The user prefers responses with emoji.");
      }
    } catch {
      // Preference query failed — skip
    }
  }

  // Inject core memory (user profile) into system prompt for orchestrator
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const coreMemory = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId: options.ownerId, key: "core_memory" },
      );
      if (coreMemory) {
        systemParts.push(`\n\n# User Profile\n${coreMemory}`);
      }
    } catch {
      // Core memory query failed — skip
    }
  }

  const maxTaskDepthValue = Number(agent.maxTaskDepth ?? 2);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue) && maxTaskDepthValue >= 0
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

// ─── fetchAgentContext ──────────────────────────────────────────────────────
// Returns everything the local agent runtime needs in a single round-trip:
// system prompt, dynamic context, tool allowlist, core memory, skills,
// thread history, and a proxy token for LLM access.

const agentContextResultValidator = v.object({
  systemPrompt: v.string(),
  dynamicContext: v.string(),
  toolsAllowlist: v.optional(v.array(v.string())),
  model: v.string(),
  fallbackModel: v.optional(v.string()),
  maxTaskDepth: v.number(),
  defaultSkills: v.array(v.string()),
  skillIds: v.array(v.string()),
  coreMemory: v.optional(v.string()),
  threadHistory: v.optional(v.array(v.object({
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
  }))),
  activeThreadId: v.optional(v.string()),
  proxyToken: v.object({
    token: v.string(),
    expiresAt: v.number(),
  }),
  gatewayApiKey: v.optional(v.string()),
});
type AgentContextResult = Infer<typeof agentContextResultValidator>;

const fetchAgentContextInternalArgs = {
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
};

const fetchAgentContextRuntimeArgs = {
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
};

const fetchLocalAgentContextRuntimeArgs = {
  agentType: v.string(),
  runId: v.string(),
};

const fetchAgentContextForOwner = async (
  ctx: ActionCtx,
  args: FetchAgentContextSharedArgs,
): Promise<AgentContextResult> => {
  // 1. Build system prompt (includes skills, device status, threads, core memory)
  const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
  });

  // 2. Get core memory separately for the local runtime to use
  let coreMemory: string | undefined;
  try {
    coreMemory = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: "core_memory" },
    ) ?? undefined;
  } catch {
    // Skip if unavailable
  }

  // 3. Resolve primary/fallback models for the runtime.
  const modelDefaults = getModelConfig(args.agentType);
  let model = modelDefaults.model;
  try {
    const override = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: `model_config:${args.agentType}` },
    );
    if (typeof override === "string" && override.trim().length > 0) {
      model = override.trim();
    }
  } catch {
    // Ignore model override lookup errors; defaults remain valid.
  }

  // 4. Get thread history if we have an active thread
  let threadHistory: Array<{ role: string; content: string; toolCallId?: string }> | undefined;
  let activeThreadId: string | undefined;

  const resolvedThreadId = args.threadId ?? await ctx.runQuery(
    internal.conversations.getActiveThreadId,
    { conversationId: args.conversationId },
  );

    if (resolvedThreadId) {
      activeThreadId = resolvedThreadId;
      try {
      const messages = await ctx.runQuery(
        internal.data.threads.loadThreadMessages,
        {
          threadId: resolvedThreadId as Id<"threads">,
        },
      );
      const recent = messages.slice(-(args.maxHistoryMessages ?? 50));
      if (recent.length > 0) {
        threadHistory = recent.map((m: { role: string; content: string; toolCallId?: string }) => ({
          role: m.role,
          content: m.content,
          toolCallId: m.toolCallId,
        }));
      }
    } catch {
      // Thread messages unavailable
    }
  }

  // 5. Mint a proxy token for this run
  const proxyToken = await ctx.runMutation(internal.ai_proxy_data.mintProxyToken, {
    ownerId: args.ownerId,
    agentType: args.agentType,
    runId: args.runId,
  });

  return {
    systemPrompt: promptBuild.systemPrompt,
    dynamicContext: promptBuild.dynamicContext,
    toolsAllowlist: promptBuild.toolsAllowlist,
    model,
    fallbackModel: modelDefaults.fallback,
    maxTaskDepth: promptBuild.maxTaskDepth,
    defaultSkills: promptBuild.defaultSkills,
    skillIds: promptBuild.skillIds,
    coreMemory,
    threadHistory,
    activeThreadId,
    proxyToken,
    gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
  };
};

export const fetchAgentContext = internalAction({
  args: fetchAgentContextInternalArgs,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    return await fetchAgentContextForOwner(ctx, args);
  },
});

export const fetchAgentContextForRuntime = action({
  args: fetchAgentContextRuntimeArgs,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    const ownerId = await requireUserId(ctx);
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });
    if (!conversation || conversation.ownerId !== ownerId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    return await fetchAgentContextForOwner(ctx, {
      ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: args.runId,
      threadId: args.threadId,
      maxHistoryMessages: args.maxHistoryMessages,
    });
  },
});

export const fetchLocalAgentContextForRuntime = action({
  args: fetchLocalAgentContextRuntimeArgs,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    const ownerId = await requireUserId(ctx);

    const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
      ownerId,
    });
    const modelDefaults = getModelConfig(args.agentType);

    let model = modelDefaults.model;
    try {
      const override = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId, key: `model_config:${args.agentType}` },
      );
      if (typeof override === "string" && override.trim().length > 0) {
        model = override.trim();
      }
    } catch {
      // Ignore model override lookup errors for local bootstrap.
    }

    let coreMemory: string | undefined;
    try {
      coreMemory = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId, key: "core_memory" },
      ) ?? undefined;
    } catch {
      // Skip if unavailable
    }

    const proxyToken = await ctx.runMutation(internal.ai_proxy_data.mintProxyToken, {
      ownerId,
      agentType: args.agentType,
      runId: args.runId,
    });

    return {
      systemPrompt: promptBuild.systemPrompt,
      dynamicContext: promptBuild.dynamicContext,
      toolsAllowlist: promptBuild.toolsAllowlist,
      model,
      fallbackModel: modelDefaults.fallback,
      maxTaskDepth: promptBuild.maxTaskDepth,
      defaultSkills: promptBuild.defaultSkills,
      skillIds: promptBuild.skillIds,
      coreMemory,
      threadHistory: undefined,
      activeThreadId: undefined,
      proxyToken,
      gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
    };
  },
});
