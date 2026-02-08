import { mutation, query, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { secretMountsValidator } from "../shared_validators";
import { BUILTIN_SKILLS } from "../prompts/index";

type SecretMountSpec = {
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

type SecretMountBinding = string | SecretMountSpec;
type SecretMountMap = Record<string, SecretMountBinding>;
type SecretMounts = SecretMountMap | { env?: SecretMountMap; files?: SecretMountMap };

const skillValidator = v.object({
  _id: v.id("skills"),
  _creationTime: v.number(),
  id: v.string(),
  name: v.string(),
  description: v.string(),
  markdown: v.string(),
  agentTypes: v.array(v.string()),
  toolsAllowlist: v.optional(v.array(v.string())),
  tags: v.optional(v.array(v.string())),
  execution: v.optional(v.string()),
  requiresSecrets: v.optional(v.array(v.string())),
  publicIntegration: v.optional(v.boolean()),
  secretMounts: secretMountsValidator,
  version: v.number(),
  source: v.string(),
  enabled: v.boolean(),
  updatedAt: v.number(),
});

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
      : "Skill instructions.";
  const markdown =
    typeof record.markdown === "string" && record.markdown.trim()
      ? record.markdown
      : "";

  const agentTypes = coerceStringArray(record.agentTypes);
  const toolsAllowlist = coerceStringArray(record.toolsAllowlist);
  const tags = coerceStringArray(record.tags);
  const requiresSecrets = coerceStringArray(record.requiresSecrets);
  const secretMounts = normalizeSecretMounts(record.secretMounts);

  const versionNumber = Number(record.version ?? 1);
  const version = Number.isFinite(versionNumber) && versionNumber > 0 ? Math.floor(versionNumber) : 1;

  const enabled = record.enabled === false ? false : true;

  return {
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

const upsertSkill = async (ctx: MutationCtx, skill: SkillRecord) => {
  const existing = await ctx.db
    .query("skills")
    .withIndex("by_skill_key", (q) => q.eq("id", skill.id))
    .take(1);

  if (existing[0]) {
    await ctx.db.patch(existing[0]._id, {
      ...skill,
      updatedAt: Date.now(),
    });
    return existing[0]._id;
  }

  return await ctx.db.insert("skills", {
    ...skill,
    updatedAt: Date.now(),
  });
};

export const upsertMany = mutation({
  args: {
    skills: v.array(skillImportValidator),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    const items = Array.isArray(args.skills) ? args.skills : [];
    let upserted = 0;
    for (const item of items) {
      const skill = normalizeSkill(item);
      if (!skill) continue;
      await upsertSkill(ctx, skill);
      upserted += 1;
    }
    return { upserted };
  },
});

export const listEnabledSkills = query({
  args: {
    agentType: v.string(),
  },
  returns: v.array(skillValidator),
  handler: async (ctx, args) => {
    // Use by_enabled index to fetch only enabled skills, then post-filter by agentType
    const enabledSkills = await ctx.db
      .query("skills")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(400);
    return enabledSkills.filter((skill) => {
      if (!skill.agentTypes || skill.agentTypes.length === 0) return true;
      return skill.agentTypes.includes(args.agentType);
    });
  },
});

export const getSkillById = query({
  args: {
    skillId: v.string(),
  },
  returns: v.union(skillValidator, v.null()),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("skills")
      .withIndex("by_skill_key", (q) => q.eq("id", args.skillId))
      .take(1);
    return results[0] ?? null;
  },
});

export const listSkills = query({
  args: {},
  returns: v.array(skillValidator),
  handler: async (ctx) => {
    return await ctx.db.query("skills").withIndex("by_updated").order("desc").take(400);
  },
});

export const ensureBuiltinSkills = mutation({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx) => {
    for (const skill of BUILTIN_SKILLS) {
      await upsertSkill(ctx, {
        ...skill,
        version: 1,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});
