import { mutation, query, MutationCtx } from "./_generated/server";
import { v } from "convex/values";

type SkillRecord = {
  id: string;
  name: string;
  description: string;
  markdown: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  tags?: string[];
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
    skills: v.any(),
  },
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
  handler: async (ctx, args) => {
    const all = await ctx.db.query("skills").withIndex("by_updated").order("desc").take(400);
    return all.filter((skill) => {
      if (!skill.enabled) return false;
      if (!skill.agentTypes || skill.agentTypes.length === 0) return true;
      return skill.agentTypes.includes(args.agentType);
    });
  },
});

export const listSkills = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("skills").withIndex("by_updated").order("desc").take(400);
  },
});
