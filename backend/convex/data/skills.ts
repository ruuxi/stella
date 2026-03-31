import {
  mutation,
  internalMutation,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { v } from "convex/values";
import { secretMountsValidator } from "../shared_validators";
import { requireConnectedUserId, requireUserId } from "../auth";
import { coerceStringArray } from "../lib/coerce";


type SecretMountSpec = {
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

type SecretMountBinding = string | SecretMountSpec;
type SecretMountMap = Record<string, SecretMountBinding>;
type SecretMounts = SecretMountMap | { env?: SecretMountMap; files?: SecretMountMap };

const skillImportValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  markdown: v.optional(v.string()),
  agentTypes: v.optional(v.union(v.array(v.string()), v.string())),
  toolsAllowlist: v.optional(v.union(v.array(v.string()), v.string())),
  tags: v.optional(v.union(v.array(v.string()), v.string())),
  execution: v.optional(v.string()),
  requiresSecrets: v.optional(v.union(v.array(v.string()), v.string())),
  publicIntegration: v.optional(v.boolean()),
  secretMounts: secretMountsValidator,
  version: v.optional(v.number()),
  source: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
});

type SkillRecord = {
  ownerId?: string;
  id: string;
  name: string;
  description: string;
  markdown: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  tags?: string[];
  execution?: string;
  requiresSecrets?: string[];
  publicIntegration?: boolean;
  secretMounts?: SecretMounts;
  version: number;
  source: string;
  enabled: boolean;
  updatedAt: number;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeSecretMountBinding = (value: unknown): SecretMountBinding | undefined => {
  if (typeof value === "string") {
    const provider = value.trim();
    return provider.length > 0 ? provider : undefined;
  }
  if (!isObjectRecord(value)) return undefined;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  if (!provider) return undefined;
  return {
    provider,
    label: typeof value.label === "string" ? value.label : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    placeholder: typeof value.placeholder === "string" ? value.placeholder : undefined,
  };
};

const normalizeSecretMountMap = (value: unknown): SecretMountMap | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, raw]) => {
      const mountKey = key.trim();
      if (!mountKey) return null;
      const binding = normalizeSecretMountBinding(raw);
      if (!binding) return null;
      return [mountKey, binding] as const;
    })
    .filter((entry): entry is readonly [string, SecretMountBinding] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeSecretMounts = (value: unknown): SecretMounts | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const hasNestedMounts = "env" in value || "files" in value;
  if (hasNestedMounts) {
    const env = normalizeSecretMountMap(value.env);
    const files = normalizeSecretMountMap(value.files);
    if (!env && !files) return undefined;
    return {
      ...(env ? { env } : {}),
      ...(files ? { files } : {}),
    };
  }
  return normalizeSecretMountMap(value);
};

const normalizeSkill = (value: unknown): SkillRecord | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;

  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : id;
  const markdown =
    typeof record.markdown === "string" && record.markdown.trim()
      ? record.markdown
      : "";

  const agentTypes = coerceStringArray(record.agentTypes);
  const toolsAllowlist = coerceStringArray(record.toolsAllowlist);
  const tags = coerceStringArray(record.tags);
  const requiresSecrets = coerceStringArray(record.requiresSecrets);
  const secretMounts = normalizeSecretMounts(record.secretMounts);

  const versionNumber = Number(record.version);
  const version = Number.isFinite(versionNumber) && versionNumber > 0 ? Math.floor(versionNumber) : 1;

  const enabled = record.enabled === false ? false : true;

  return {
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
    id,
    name,
    description,
    markdown,
    agentTypes,
    toolsAllowlist: toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    tags: tags.length > 0 ? tags : undefined,
    execution: typeof record.execution === "string" ? record.execution : undefined,
    requiresSecrets: requiresSecrets.length > 0 ? requiresSecrets : undefined,
    publicIntegration: record.publicIntegration === true ? true : undefined,
    secretMounts,
    version,
    source: typeof record.source === "string" ? record.source : "local",
    enabled,
    updatedAt: Date.now(),
  };
};

const upsertSkill = async (
  ctx: MutationCtx,
  ownerId: string,
  skill: SkillRecord,
) => {
  const existing = await ctx.db
    .query("skills")
    .withIndex("by_ownerId_and_id", (q) =>
      q.eq("ownerId", ownerId).eq("id", skill.id),
    )
    .unique();

  const payload = {
    ...skill,
    ownerId,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, payload);
    return existing._id;
  }

  return await ctx.db.insert("skills", payload);
};

const upsertManyHandler = async (
  ctx: MutationCtx,
  args: { skills: unknown[] },
  ownerId: string,
) => {
  const items = Array.isArray(args.skills) ? args.skills : [];
  let upserted = 0;
  for (const item of items) {
    const skill = normalizeSkill(item);
    if (!skill) continue;
    await upsertSkill(ctx, ownerId, skill);
    upserted += 1;
  }
  return { upserted };
};

export const upsertMany = mutation({
  args: {
    skills: v.array(skillImportValidator),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    return await upsertManyHandler(ctx, args, ownerId);
  },
});

export const upsertManyInternal = internalMutation({
  args: {
    ownerId: v.optional(v.string()),
    skills: v.array(skillImportValidator),
  },
  handler: async (ctx, args) => {
    const ownerId = args.ownerId ?? await requireUserId(ctx);
    return await upsertManyHandler(ctx, args, ownerId);
  },
});

const supportsAgentType = (agentTypes: string[] | undefined, agentType: string) =>
  !agentTypes || agentTypes.length === 0 || agentTypes.includes(agentType);

const listEnabledSkillsHandler = async (
  ctx: QueryCtx,
  args: { agentType: string; ownerId?: string },
) => {
  if (!args.ownerId) {
    return [];
  }

  const ownerScoped = await ctx.db
    .query("skills")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId!))
    .order("desc")
    .take(400);

  return ownerScoped.filter((skill) =>
    skill.enabled !== false && supportsAgentType(skill.agentTypes, args.agentType));
};

export const listEnabledSkills = internalQuery({
  args: {
    agentType: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    return await listEnabledSkillsHandler(ctx, { ...args, ownerId });
  },
});

export const listEnabledSkillsInternal = internalQuery({
  args: {
    agentType: v.string(),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await listEnabledSkillsHandler(ctx, args);
  },
});

const getSkillByIdHandler = async (
  ctx: QueryCtx,
  args: { skillId: string; ownerId?: string },
) => {
  if (!args.ownerId) {
    return null;
  }

  return await ctx.db
    .query("skills")
    .withIndex("by_ownerId_and_id", (q) =>
      q.eq("ownerId", args.ownerId!).eq("id", args.skillId),
    )
    .first();
};

export const getSkillById = internalQuery({
  args: {
    skillId: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    return await getSkillByIdHandler(ctx, { ...args, ownerId });
  },
});

export const getSkillByIdInternal = internalQuery({
  args: {
    skillId: v.string(),
    ownerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await getSkillByIdHandler(ctx, args);
  },
});

export const listSkills = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("skills")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(400);
  },
});

// ---------------------------------------------------------------------------
// Skill Selection (onboarding)
// ---------------------------------------------------------------------------

export const listAllSkillsForSelection = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerSkills = await ctx.db
      .query("skills")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(400);

    return ownerSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
    }));
  },
});

export const enableSelectedSkills = internalMutation({
  args: {
    ownerId: v.string(),
    skillIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let enabled = 0;
    let disabled = 0;
    const selectedSet = new Set(args.skillIds);

    const ownerSkills = await ctx.db
      .query("skills")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(400);

    const ownerById = new Map(ownerSkills.map((skill) => [skill.id, skill]));

    for (const skillId of selectedSet) {
      const ownerSkill = ownerById.get(skillId);
      if (!ownerSkill) continue;
      if (!ownerSkill.enabled) {
        await ctx.db.patch(ownerSkill._id, { enabled: true, updatedAt: now });
      }
      enabled += 1;
    }

    for (const ownerSkill of ownerById.values()) {
      if (selectedSet.has(ownerSkill.id)) continue;
      if (!ownerSkill.enabled) continue;

      await ctx.db.patch(ownerSkill._id, { enabled: false, updatedAt: now });
      disabled += 1;
    }

    return { enabled, disabled };
  },
});

