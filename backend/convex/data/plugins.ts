import {
  mutation,
  query,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { v } from "convex/values";
import { z } from "zod";
import { jsonSchemaValidator } from "../shared_validators";
import { requireUserId } from "../auth";
import { BUILTIN_OWNER_ID } from "../lib/owner_ids";

const pluginValidator = v.object({
  _id: v.id("plugins"),
  _creationTime: v.number(),
  ownerId: v.optional(v.string()),
  id: v.string(),
  name: v.string(),
  version: v.string(),
  description: v.optional(v.string()),
  source: v.string(),
  updatedAt: v.number(),
});

const pluginToolValidator = v.object({
  _id: v.id("plugin_tools"),
  _creationTime: v.number(),
  ownerId: v.optional(v.string()),
  id: v.string(),
  pluginId: v.string(),
  name: v.string(),
  description: v.string(),
  inputSchema: jsonSchemaValidator,
  source: v.string(),
  updatedAt: v.number(),
});

const pluginImportValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  version: v.optional(v.string()),
  description: v.optional(v.string()),
  source: v.optional(v.string()),
});

const pluginToolImportValidator = v.object({
  pluginId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  inputSchema: v.optional(jsonSchemaValidator),
  source: v.optional(v.string()),
});

type PluginRecord = {
  ownerId?: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  source: string;
  updatedAt: number;
};

type ToolDescriptor = {
  ownerId?: string;
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: string;
};

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const coerceString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const normalizePlugin = (value: unknown): PluginRecord | null => {
  if (!isObjectRecord(value)) return null;
  const id = coerceString(value.id, "");
  if (!id) return null;

  return {
    ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
    id,
    name: coerceString(value.name, id),
    version: coerceString(value.version, "0.0.0"),
    description:
      typeof value.description === "string" && value.description.trim()
        ? value.description.trim()
        : undefined,
    source: coerceString(value.source, "local"),
    updatedAt: Date.now(),
  };
};

const normalizeTool = (value: unknown): ToolDescriptor | null => {
  if (!isObjectRecord(value)) return null;

  const pluginId = coerceString(value.pluginId, "");
  const name = coerceString(value.name, "");
  if (!pluginId || !name) return null;

  const description = coerceString(value.description, `Plugin tool: ${name}`);
  const inputSchema = isObjectRecord(value.inputSchema)
    ? (value.inputSchema as Record<string, unknown>)
    : { type: "object", properties: {}, required: [] };

  return {
    ownerId: typeof value.ownerId === "string" ? value.ownerId : undefined,
    pluginId,
    name,
    description,
    inputSchema,
    source: coerceString(value.source, "local"),
  };
};

const upsertPlugin = async (
  ctx: MutationCtx,
  ownerId: string,
  plugin: PluginRecord,
) => {
  const existing = await ctx.db
    .query("plugins")
    .withIndex("by_owner_and_plugin_key", (q) =>
      q.eq("ownerId", ownerId).eq("id", plugin.id),
    )
    .first();

  const payload = {
    ...plugin,
    ownerId,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, payload);
    return existing._id;
  }

  return await ctx.db.insert("plugins", payload);
};

const upsertPluginTool = async (
  ctx: MutationCtx,
  ownerId: string,
  tool: ToolDescriptor,
) => {
  const id = `${tool.pluginId}:${tool.name}`;
  const existing = await ctx.db
    .query("plugin_tools")
    .withIndex("by_owner_and_tool_key", (q) =>
      q.eq("ownerId", ownerId).eq("id", id),
    )
    .first();

  const payload = {
    ownerId,
    id,
    pluginId: tool.pluginId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: tool.source,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, payload);
    return existing._id;
  }

  return await ctx.db.insert("plugin_tools", payload);
};

const listPluginsForOwner = async (ctx: QueryCtx, ownerId: string) => {
  const [legacyBuiltins, builtins, ownerPlugins] = await Promise.all([
    ctx.db
      .query("plugins")
      .withIndex("by_updated")
      .order("desc")
      .take(200)
      .then((rows) =>
        rows.filter((plugin) => plugin.ownerId === undefined && plugin.source === "builtin"),
      ),
    ctx.db
      .query("plugins")
      .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", BUILTIN_OWNER_ID))
      .order("desc")
      .take(200),
    ctx.db
      .query("plugins")
      .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200),
  ]);

  const merged = new Map<string, (typeof ownerPlugins)[number]>();
  for (const plugin of legacyBuiltins) merged.set(plugin.id, plugin);
  for (const plugin of builtins) merged.set(plugin.id, plugin);
  for (const plugin of ownerPlugins) merged.set(plugin.id, plugin);

  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
};

const listToolsForOwner = async (ctx: QueryCtx, ownerId?: string) => {
  const [legacyBuiltins, builtins, ownerTools] = await Promise.all([
    ctx.db
      .query("plugin_tools")
      .withIndex("by_name")
      .order("asc")
      .take(400)
      .then((rows) =>
        rows.filter((tool) => tool.ownerId === undefined && tool.source === "builtin"),
      ),
    ctx.db
      .query("plugin_tools")
      .withIndex("by_owner_and_name", (q) => q.eq("ownerId", BUILTIN_OWNER_ID))
      .order("asc")
      .take(400),
    ownerId
      ? ctx.db
          .query("plugin_tools")
          .withIndex("by_owner_and_name", (q) => q.eq("ownerId", ownerId))
          .order("asc")
          .take(400)
      : Promise.resolve([]),
  ]);

  const merged = new Map<string, (typeof builtins)[number]>();
  for (const tool of legacyBuiltins) merged.set(tool.id, tool);
  for (const tool of builtins) merged.set(tool.id, tool);
  for (const tool of ownerTools) merged.set(tool.id, tool);

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
};

export const upsertMany = mutation({
  args: {
    plugins: v.array(pluginImportValidator),
    tools: v.array(pluginToolImportValidator),
  },
  returns: v.object({
    pluginsUpserted: v.number(),
    toolsUpserted: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const pluginItems = Array.isArray(args.plugins) ? args.plugins : [];
    const toolItems = Array.isArray(args.tools) ? args.tools : [];

    let pluginsUpserted = 0;
    for (const item of pluginItems) {
      const plugin = normalizePlugin(item);
      if (!plugin) continue;
      await upsertPlugin(ctx, ownerId, plugin);
      pluginsUpserted += 1;
    }

    let toolsUpserted = 0;
    for (const item of toolItems) {
      const tool = normalizeTool(item);
      if (!tool) continue;
      await upsertPluginTool(ctx, ownerId, tool);
      toolsUpserted += 1;
    }

    return { pluginsUpserted, toolsUpserted };
  },
});

export const listPlugins = internalQuery({
  args: {},
  returns: v.array(pluginValidator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await listPluginsForOwner(ctx, ownerId);
  },
});

export const listToolDescriptors = internalQuery({
  args: {},
  returns: v.array(pluginToolValidator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await listToolsForOwner(ctx, ownerId);
  },
});

export const listToolDescriptorsInternal = internalQuery({
  args: {
    ownerId: v.optional(v.string()),
  },
  returns: v.array(pluginToolValidator),
  handler: async (ctx, args) => {
    return await listToolsForOwner(ctx, args.ownerId);
  },
});

const baseScalarSchema = (type: string | undefined) => {
  if (type === "number" || type === "integer") return z.number();
  if (type === "boolean") return z.boolean();
  return z.string();
};

const jsonSchemaToZodInternal = (schema: JsonSchema | undefined): z.ZodTypeAny => {
  if (!schema || typeof schema !== "object") {
    return z.object({}).passthrough();
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const enumValues = schema.enum.filter((value): value is string => typeof value === "string");
    if (enumValues.length > 0) {
      return z.enum(enumValues as [string, ...string[]]);
    }
  }

  if (schema.type === "array") {
    const itemSchema = jsonSchemaToZodInternal(schema.items);
    return z.array(itemSchema);
  }

  if (schema.type !== "object") {
    return baseScalarSchema(schema.type);
  }

  const properties = isObjectRecord(schema.properties) ? schema.properties : {};
  const requiredSet = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const child = jsonSchemaToZodInternal(value);
    shape[key] = requiredSet.has(key) ? child : child.optional();
  }

  return z.object(shape).passthrough();
};

export const jsonSchemaToZod = (schema: Record<string, unknown> | undefined) => {
  return jsonSchemaToZodInternal(schema as JsonSchema | undefined);
};
