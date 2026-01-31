import { mutation, query, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  GENERAL_AGENT_SYSTEM_PROMPT,
  SELF_MOD_AGENT_SYSTEM_PROMPT,
  EXPLORE_AGENT_SYSTEM_PROMPT,
  BROWSER_AGENT_SYSTEM_PROMPT,
  buildDiscoveryBrowserPrompt,
  buildDiscoveryDevPrompt,
  buildDiscoveryCommsPrompt,
  buildDiscoveryAppsPrompt,
} from "./prompts";

const agentValidator = v.object({
  _id: v.id("agents"),
  _creationTime: v.number(),
  id: v.string(),
  name: v.string(),
  description: v.string(),
  systemPrompt: v.string(),
  agentTypes: v.array(v.string()),
  toolsAllowlist: v.optional(v.array(v.string())),
  defaultSkills: v.optional(v.array(v.string())),
  model: v.optional(v.string()),
  maxTaskDepth: v.optional(v.number()),
  version: v.number(),
  source: v.string(),
  updatedAt: v.number(),
});

// Sanitized agent (without model field) for client responses
const agentClientValidator = v.object({
  _id: v.id("agents"),
  _creationTime: v.number(),
  id: v.string(),
  name: v.string(),
  description: v.string(),
  systemPrompt: v.string(),
  agentTypes: v.array(v.string()),
  toolsAllowlist: v.optional(v.array(v.string())),
  defaultSkills: v.optional(v.array(v.string())),
  maxTaskDepth: v.optional(v.number()),
  version: v.number(),
  source: v.string(),
  updatedAt: v.number(),
});

type AgentRecord = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  defaultSkills?: string[];
  maxTaskDepth?: number;
  version: number;
  source: string;
  updatedAt: number;
};

const BUILTIN_AGENT_DEFS: AgentRecord[] = [
  {
    id: "general",
    name: "General Agent",
    description: "Handles user tasks using available tools.",
    systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT,
    agentTypes: ["general"],
    toolsAllowlist: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "KillShell",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "TestWrite",
      "AgentInvoke",
      "Task",
      "TaskOutput",
      "AskUserQuestion",
      "RequestCredential",
      "IntegrationRequest",
      "SkillBash",
      "ImageGenerate",
      "ImageEdit",
      "VideoGenerate",
      "MemorySearch",
    ],
    defaultSkills: [],
    maxTaskDepth: 2,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  // {
  //   id: "self_mod",
  //   name: "Self-Modification Agent",
  //   description: "Modifies Stellar itself with care.",
  //   systemPrompt: SELF_MOD_AGENT_SYSTEM_PROMPT,
  //   agentTypes: ["self_mod"],
  //   toolsAllowlist: [
  //     "Read",
  //     "Write",
  //     "Edit",
  //     "Glob",
  //     "Grep",
  //     "Bash",
  //     "KillShell",
  //     "WebFetch",
  //     "WebSearch",
  //     "TodoWrite",
  //     "TestWrite",
  //     "AgentInvoke",
  //     "Task",
  //     "TaskOutput",
  //     "AskUserQuestion",
  //   ],
  //   defaultSkills: [],
  //   maxTaskDepth: 2,
  //   version: 1,
  //   source: "builtin",
  //   updatedAt: 0,
  // },
  {
    id: "explore",
    name: "Explore Agent",
    description:
      "Primary investigator for codebase exploration and web research. Use liberally for file discovery, pattern searching, documentation lookup, and understanding code structure.",
    systemPrompt: EXPLORE_AGENT_SYSTEM_PROMPT,
    agentTypes: ["explore"],
    toolsAllowlist: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "browser",
    name: "Browser Agent",
    description:
      "Web browsing and browser automation specialist. Use for navigating websites, interacting with web applications, taking screenshots, filling forms, and extracting information from web pages via Playwright.",
    systemPrompt: BROWSER_AGENT_SYSTEM_PROMPT,
    agentTypes: ["browser"],
    toolsAllowlist: [
      "Bash",
      "Read",
    ],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "discovery_browser",
    name: "Browser Discovery Agent",
    description: "Discovers browser history, bookmarks, searches, downloads, and profiles.",
    systemPrompt: buildDiscoveryBrowserPrompt({ platform: "win32", trustLevel: "basic" }),
    agentTypes: ["discovery_browser"],
    toolsAllowlist: ["Bash", "Read", "Glob", "Grep", "SqliteQuery"],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "discovery_dev",
    name: "Development Discovery Agent",
    description: "Discovers gitconfig, shell history, SSH config, IDE state, and dev tools.",
    systemPrompt: buildDiscoveryDevPrompt({ platform: "win32", trustLevel: "basic" }),
    agentTypes: ["discovery_dev"],
    toolsAllowlist: ["Bash", "Read", "Glob", "Grep", "SqliteQuery"],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "discovery_comms",
    name: "Communication Discovery Agent",
    description: "Discovers messaging patterns, contacts, and communication platforms.",
    systemPrompt: buildDiscoveryCommsPrompt({ platform: "win32", trustLevel: "basic" }),
    agentTypes: ["discovery_comms"],
    toolsAllowlist: ["Bash", "Read", "Glob", "Grep", "SqliteQuery"],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "discovery_apps",
    name: "Apps & Media Discovery Agent",
    description: "Discovers app usage, recent files, notes, calendar, and media preferences.",
    systemPrompt: buildDiscoveryAppsPrompt({ platform: "win32", trustLevel: "basic" }),
    agentTypes: ["discovery_apps"],
    toolsAllowlist: ["Bash", "Read", "Glob", "Grep", "SqliteQuery"],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
];

const coerceStringArray = (value: unknown) => {
  if (!value) return [] as string[];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : String(item)))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [String(value)];
};

const normalizeAgent = (value: unknown): AgentRecord | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;

  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : "Agent instructions.";
  const systemPrompt =
    typeof record.systemPrompt === "string" && record.systemPrompt.trim()
      ? record.systemPrompt
      : "You are an agent.";

  const agentTypes = coerceStringArray(record.agentTypes);
  const toolsAllowlist = coerceStringArray(record.toolsAllowlist);
  const defaultSkills = coerceStringArray(record.defaultSkills);

  const versionNumber = Number(record.version ?? 1);
  const version = Number.isFinite(versionNumber) && versionNumber > 0 ? Math.floor(versionNumber) : 1;

  const maxTaskDepthNumber = Number(record.maxTaskDepth);
  const maxTaskDepth =
    Number.isFinite(maxTaskDepthNumber) && maxTaskDepthNumber > 0
      ? Math.floor(maxTaskDepthNumber)
      : undefined;

  return {
    id,
    name,
    description,
    systemPrompt,
    agentTypes,
    toolsAllowlist: toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    defaultSkills: defaultSkills.length > 0 ? defaultSkills : undefined,
    maxTaskDepth,
    version,
    source: typeof record.source === "string" ? record.source : "local",
    updatedAt: Date.now(),
  };
};

const sanitizeAgentForClient = <T extends Record<string, unknown> | null | undefined>(
  agent: T,
) => {
  if (!agent) return agent;
  const { model: _model, ...rest } = agent;
  return rest;
};

const upsertAgent = async (ctx: MutationCtx, agent: AgentRecord) => {
  const existing = await ctx.db
    .query("agents")
    .withIndex("by_agent_key", (q) => q.eq("id", agent.id))
    .take(1);

  const { model: _model, ...safeAgent } = agent as AgentRecord & { model?: string };

  if (existing[0]) {
    await ctx.db.patch(existing[0]._id, {
      ...safeAgent,
      updatedAt: Date.now(),
    });
    return existing[0]._id;
  }

  return await ctx.db.insert("agents", {
    ...safeAgent,
    updatedAt: Date.now(),
  });
};

export const ensureBuiltins = mutation({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx) => {
    for (const builtin of BUILTIN_AGENT_DEFS) {
      await upsertAgent(ctx, {
        ...builtin,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

export const upsertMany = mutation({
  args: {
    agents: v.array(v.any()),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    const items = Array.isArray(args.agents) ? args.agents : [];
    let upserted = 0;
    for (const item of items) {
      const agent = normalizeAgent(item);
      if (!agent) continue;
      await upsertAgent(ctx, agent);
      upserted += 1;
    }
    return { upserted };
  },
});

export const getAgentConfig = query({
  args: {
    agentType: v.string(),
  },
  returns: v.object({
    id: v.string(),
    name: v.string(),
    description: v.string(),
    systemPrompt: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    defaultSkills: v.optional(v.array(v.string())),
    maxTaskDepth: v.optional(v.number()),
    version: v.number(),
    source: v.string(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("agents")
      .withIndex("by_agent_key", (q) => q.eq("id", args.agentType))
      .take(1);

    if (record[0]) {
      return sanitizeAgentForClient(record[0]) as any;
    }

    const builtin = BUILTIN_AGENT_DEFS.find((agent) => agent.id === args.agentType);
    if (builtin) {
      return sanitizeAgentForClient({
        ...builtin,
        updatedAt: Date.now(),
      }) as any;
    }

    return sanitizeAgentForClient({
      id: args.agentType,
      name: args.agentType,
      description: "Agent instructions.",
      systemPrompt: GENERAL_AGENT_SYSTEM_PROMPT,
      agentTypes: [args.agentType],
      toolsAllowlist: undefined,
      defaultSkills: [],
      maxTaskDepth: 2,
      version: 1,
      source: "fallback",
      updatedAt: Date.now(),
    }) as any;
  },
});

export const listAgents = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("agents"),
    _creationTime: v.number(),
    id: v.string(),
    name: v.string(),
    description: v.string(),
    systemPrompt: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    defaultSkills: v.optional(v.array(v.string())),
    maxTaskDepth: v.optional(v.number()),
    version: v.number(),
    source: v.string(),
    updatedAt: v.number(),
  })),
  handler: async (ctx) => {
    const records = await ctx.db
      .query("agents")
      .withIndex("by_updated")
      .order("desc")
      .take(200);
    return records.map((record) => sanitizeAgentForClient(record)) as any;
  },
});
