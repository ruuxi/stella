import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { ConvexError, Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireUserId } from "../auth";
import { getModelConfig } from "./model";
import {
  GENERAL_AGENT_ENGINE_KEY,
  CODEX_LOCAL_MAX_CONCURRENCY_KEY,
  DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY,
  normalizeGeneralAgentEngine,
  normalizeCodexLocalMaxConcurrency,
} from "../data/preferences";
import { SKILLS_DISABLED_AGENT_TYPES } from "../lib/agent_constants";

export type PromptBuildResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  timezone: string;
};

const MAX_ACTIVE_THREADS_IN_PROMPT = 12;
type FetchAgentContextSharedArgs = {
  ownerId: string;
  conversationId: Id<"conversations">;
  agentType: string;
  runId: string;
  threadId?: Id<"threads">;
  maxHistoryMessages?: number;
  platform?: string;
  timezone?: string;
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

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd /c start "" <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\`
`.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\`
`.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\`
`.trim();
  }

  return "";
};

export const buildSystemPrompt = async (
  ctx: ActionCtx,
  agentType: string,
  options?: { ownerId?: string; conversationId?: Id<"conversations">; platform?: string; timezone?: string },
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

  // Platform guidance — stable per device, belongs in system prompt
  if (options?.platform) {
    const guidance = getPlatformGuidance(options.platform);
    if (guidance) {
      systemParts.push(guidance);
    }
  }

  // Dynamic context — injected into last user message for prompt caching
  const dynamicParts: string[] = [];

  // Current date — included in dynamic context so the model knows the date
  if (agentType === "orchestrator") {
    const tz = options?.timezone ?? "UTC";
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
    dynamicParts.push(`Today is ${dateStr}.`);
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
        const lines = visibleThreads.map((t: { _id: string; name: string }) => {
          return `- **${t.name}** (id: ${t._id})`;
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

  // Expression style — stable preference, belongs in system prompt
  if (agentType === "orchestrator" && options?.ownerId) {
    try {
      const style = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId: options.ownerId, key: "expression_style" },
      );
      if (style === "none") {
        systemParts.push("The user prefers responses without emoji.");
      } else if (style === "emoji") {
        systemParts.push("The user prefers responses with emoji.");
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
    timezone: options?.timezone ?? "UTC",
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
  generalAgentEngine: v.optional(v.union(v.literal("default"), v.literal("codex_local"))),
  codexLocalMaxConcurrency: v.optional(v.number()),
});
type AgentContextResult = Infer<typeof agentContextResultValidator>;

const fetchAgentContextInternalArgs = {
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchAgentContextRuntimeArgs = {
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchLocalAgentContextRuntimeArgs = {
  agentType: v.string(),
  runId: v.string(),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchAgentContextForOwner = async (
  ctx: ActionCtx,
  args: FetchAgentContextSharedArgs,
): Promise<AgentContextResult> => {
  // 1. Build system prompt (includes skills, threads, core memory, platform, timezone)
  const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    platform: args.platform,
    timezone: args.timezone,
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

  let generalAgentEngine: "default" | "codex_local" | undefined;
  let codexLocalMaxConcurrency: number | undefined;
  if (args.agentType === "general") {
    generalAgentEngine = "default";
    codexLocalMaxConcurrency = DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY;
    try {
      const enginePreference = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId: args.ownerId, key: GENERAL_AGENT_ENGINE_KEY },
      );
      generalAgentEngine = normalizeGeneralAgentEngine(enginePreference);
    } catch {
      // Ignore preference lookup errors; defaults remain valid.
    }
    try {
      const concurrencyPreference = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId: args.ownerId, key: CODEX_LOCAL_MAX_CONCURRENCY_KEY },
      );
      codexLocalMaxConcurrency = normalizeCodexLocalMaxConcurrency(concurrencyPreference);
    } catch {
      // Ignore preference lookup errors; defaults remain valid.
    }
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
    generalAgentEngine,
    codexLocalMaxConcurrency,
  };
};

export const fetchAgentContext = internalAction({
  args: fetchAgentContextInternalArgs,
  returns: agentContextResultValidator,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    return await fetchAgentContextForOwner(ctx, args);
  },
});

export const fetchAgentContextForRuntime = action({
  args: fetchAgentContextRuntimeArgs,
  returns: agentContextResultValidator,
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
      platform: args.platform,
      timezone: args.timezone,
    });
  },
});

export const fetchLocalAgentContextForRuntime = action({
  args: fetchLocalAgentContextRuntimeArgs,
  returns: agentContextResultValidator,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    const ownerId = await requireUserId(ctx);

    const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
      ownerId,
      platform: args.platform,
      timezone: args.timezone,
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

    let generalAgentEngine: "default" | "codex_local" | undefined;
    let codexLocalMaxConcurrency: number | undefined;
    if (args.agentType === "general") {
      generalAgentEngine = "default";
      codexLocalMaxConcurrency = DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY;
      try {
        const enginePreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: GENERAL_AGENT_ENGINE_KEY },
        );
        generalAgentEngine = normalizeGeneralAgentEngine(enginePreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
      try {
        const concurrencyPreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: CODEX_LOCAL_MAX_CONCURRENCY_KEY },
        );
        codexLocalMaxConcurrency = normalizeCodexLocalMaxConcurrency(concurrencyPreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
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
      generalAgentEngine,
      codexLocalMaxConcurrency,
    };
  },
});
