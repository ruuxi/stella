import {
  mutation,
  internalMutation,
  query,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { v, Infer } from "convex/values";
import {
  GENERAL_AGENT_SYSTEM_PROMPT,
  ORCHESTRATOR_AGENT_SYSTEM_PROMPT,
  SELF_MOD_AGENT_SYSTEM_PROMPT,
  EXPLORE_AGENT_SYSTEM_PROMPT,
  BROWSER_AGENT_SYSTEM_PROMPT,
} from "../prompts/index";
import { requireUserId } from "../auth";
import { BUILTIN_OWNER_ID } from "../lib/owner_ids";

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

// Agent config response (without _id, _creationTime, model)
const agentConfigValidator = v.object({
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

const agentImportValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  systemPrompt: v.optional(v.string()),
  agentTypes: v.optional(v.union(v.array(v.string()), v.string())),
  toolsAllowlist: v.optional(v.union(v.array(v.string()), v.string())),
  defaultSkills: v.optional(v.union(v.array(v.string()), v.string())),
  maxTaskDepth: v.optional(v.number()),
  version: v.optional(v.number()),
  source: v.optional(v.string()),
});

// Inferred types from validators for type-safe sanitization
type AgentClient = Infer<typeof agentClientValidator>;
type AgentConfig = Infer<typeof agentConfigValidator>;

type AgentRecord = {
  ownerId?: string;
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
    id: "orchestrator",
    name: "Orchestrator",
    description: "Coordinates subagents and responds to the user.",
    systemPrompt: ORCHESTRATOR_AGENT_SYSTEM_PROMPT,
    agentTypes: ["orchestrator"],
    toolsAllowlist: [
      "TaskCreate", "TaskOutput", "TaskCancel", "OpenCanvas", "CloseCanvas", "AskUserQuestion",
      "RecallMemories", "SaveMemory",
      "HeartbeatGet", "HeartbeatUpsert", "HeartbeatRun",
      "CronList", "CronAdd", "CronUpdate", "CronRemove", "CronRun",
      "SpawnRemoteMachine",
      "NoResponse",
    ],
    defaultSkills: [],
    maxTaskDepth: 2,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
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
      "RequestCredential",
      "IntegrationRequest",
      "SkillBash",
      "ListResources",
      "StoreSearch",
      "ManagePackage",
      "GenerateApiSkill",
      "MediaGenerate",
      "ActivateSkill",
    ],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
  {
    id: "self_mod",
    name: "Self-Modification Agent",
    description: "Modifies Stella's UI, styles, layouts, and canvas components. Use when the user wants to change how Stella looks or works.",
    systemPrompt: SELF_MOD_AGENT_SYSTEM_PROMPT,
    agentTypes: ["self_mod"],
    toolsAllowlist: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "KillShell",
      "OpenCanvas", "CloseCanvas",
      "WebFetch",
      "WebSearch",
      "AskUserQuestion",
      "SelfModStart",
      "SelfModApply",
      "SelfModRevert",
      "SelfModStatus",
      "SelfModPackage",
      "SelfModInstallBlueprint",
      "ActivateSkill",
    ],
    defaultSkills: [],
    maxTaskDepth: 0,
    version: 1,
    source: "builtin",
    updatedAt: 0,
  },
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
      "KillShell",
      "Read",
      "OpenCanvas", "CloseCanvas",
      "ActivateSkill",
    ],
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
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
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

/** Strip model field for client responses (keeps _id, _creationTime) */
const toAgentClient = (agent: Record<string, unknown>): AgentClient => {
  const { model: _model, ownerId: _ownerId, ...rest } = agent;
  return rest as AgentClient;
};

/** Strip model, _id, _creationTime for config responses */
const toAgentConfig = (agent: Record<string, unknown>): AgentConfig => {
  const {
    model: _model,
    ownerId: _ownerId,
    _id: _docId,
    _creationTime: _ct,
    ...rest
  } = agent;
  return rest as AgentConfig;
};

const upsertAgent = async (
  ctx: MutationCtx,
  ownerId: string,
  agent: AgentRecord,
) => {
  const existing = await ctx.db
    .query("agents")
    .withIndex("by_owner_and_agent_key", (q) =>
      q.eq("ownerId", ownerId).eq("id", agent.id),
    )
    .first();

  const { model: _model, ...safeAgent } = agent as AgentRecord & { model?: string };
  const payload = {
    ...safeAgent,
    ownerId,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, payload);
    return existing._id;
  }

  return await ctx.db.insert("agents", payload);
};

export const ensureBuiltins = internalMutation({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx) => {
    for (const builtin of BUILTIN_AGENT_DEFS) {
      await upsertAgent(ctx, BUILTIN_OWNER_ID, {
        ...builtin,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

export const upsertMany = mutation({
  args: {
    agents: v.array(agentImportValidator),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const items = Array.isArray(args.agents) ? args.agents : [];
    let upserted = 0;
    for (const item of items) {
      const agent = normalizeAgent(item);
      if (!agent) continue;
      await upsertAgent(ctx, ownerId, agent);
      upserted += 1;
    }
    return { upserted };
  },
});

const getAgentConfigHandler = async (
  ctx: QueryCtx,
  args: { agentType: string; ownerId?: string },
) => {
  if (args.ownerId) {
    const ownerRecord = await ctx.db
      .query("agents")
      .withIndex("by_owner_and_agent_key", (q) =>
        q.eq("ownerId", args.ownerId!).eq("id", args.agentType),
      )
      .first();
    if (ownerRecord) {
      return toAgentConfig(ownerRecord);
    }
  }

  const builtinRecord = await ctx.db
    .query("agents")
    .withIndex("by_owner_and_agent_key", (q) =>
      q.eq("ownerId", BUILTIN_OWNER_ID).eq("id", args.agentType),
    )
    .first();
  if (builtinRecord) {
    return toAgentConfig(builtinRecord);
  }

  const legacyRecords = await ctx.db
    .query("agents")
    .withIndex("by_agent_key", (q) => q.eq("id", args.agentType))
    .take(20);
  const legacyBuiltin = legacyRecords.find(
    (agent) => agent.ownerId === undefined && agent.source === "builtin",
  );
  if (legacyBuiltin) {
    return toAgentConfig(legacyBuiltin);
  }

  const builtin = BUILTIN_AGENT_DEFS.find((agent) => agent.id === args.agentType);
  if (builtin) {
    return toAgentConfig({
      ...builtin,
      updatedAt: Date.now(),
    });
  }

  return toAgentConfig({
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
  });
};

export const getAgentConfig = internalQuery({
  args: {
    agentType: v.string(),
  },
  returns: agentConfigValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    return await getAgentConfigHandler(ctx, { ...args, ownerId });
  },
});

export const getAgentConfigInternal = internalQuery({
  args: {
    agentType: v.string(),
    ownerId: v.optional(v.string()),
  },
  returns: agentConfigValidator,
  handler: async (ctx, args) => {
    return await getAgentConfigHandler(ctx, args);
  },
});

export const listAgents = internalQuery({
  args: {},
  returns: v.array(agentClientValidator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const [legacyBuiltins, builtinRecords, ownerRecords] = await Promise.all([
      ctx.db
        .query("agents")
        .withIndex("by_updated")
        .order("desc")
        .take(200)
        .then((rows) =>
          rows.filter((agent) => agent.ownerId === undefined && agent.source === "builtin"),
        ),
      ctx.db
        .query("agents")
        .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", BUILTIN_OWNER_ID))
        .order("desc")
        .take(200),
      ctx.db
        .query("agents")
        .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .take(200),
    ]);

    const merged = new Map<string, (typeof ownerRecords)[number]>();
    for (const record of legacyBuiltins) merged.set(record.id, record);
    for (const record of builtinRecords) merged.set(record.id, record);
    for (const record of ownerRecords) merged.set(record.id, record);

    return Array.from(merged.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => toAgentClient(record));
  },
});
