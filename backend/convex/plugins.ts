import { mutation, query, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { z } from "zod";

type PluginRecord = {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: string;
  updatedAt: number;
};

type ToolDescriptor = {
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
    pluginId,
    name,
    description,
    inputSchema,
    source: coerceString(value.source, "local"),
  };
};

const upsertPlugin = async (ctx: MutationCtx, plugin: PluginRecord) => {
  const existing = await ctx.db
    .query("plugins")
    .withIndex("by_plugin_key", (q) => q.eq("id", plugin.id))
    .take(1);

  if (existing[0]) {
    await ctx.db.patch(existing[0]._id, {
      ...plugin,
      updatedAt: Date.now(),
    });
    return existing[0]._id;
  }

  return await ctx.db.insert("plugins", {
    ...plugin,
    updatedAt: Date.now(),
  });
};

const upsertPluginTool = async (ctx: MutationCtx, tool: ToolDescriptor) => {
  const id = `${tool.pluginId}:${tool.name}`;
  const existing = await ctx.db
    .query("plugin_tools")
    .withIndex("by_tool_key", (q) => q.eq("id", id))
    .take(1);

  const payload = {
    id,
    pluginId: tool.pluginId,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: tool.source,
    updatedAt: Date.now(),
  };

  if (existing[0]) {
    await ctx.db.patch(existing[0]._id, payload);
    return existing[0]._id;
  }

  return await ctx.db.insert("plugin_tools", payload);
};

export const upsertMany = mutation({
  args: {
    plugins: v.any(),
    tools: v.any(),
  },
  handler: async (ctx, args) => {
    const pluginItems = Array.isArray(args.plugins) ? args.plugins : [];
    const toolItems = Array.isArray(args.tools) ? args.tools : [];

    let pluginsUpserted = 0;
    for (const item of pluginItems) {
      const plugin = normalizePlugin(item);
      if (!plugin) continue;
      await upsertPlugin(ctx, plugin);
      pluginsUpserted += 1;
    }

    let toolsUpserted = 0;
    for (const item of toolItems) {
      const tool = normalizeTool(item);
      if (!tool) continue;
      await upsertPluginTool(ctx, tool);
      toolsUpserted += 1;
    }

    return { pluginsUpserted, toolsUpserted };
  },
});

export const listPlugins = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("plugins").withIndex("by_updated").order("desc").take(200);
  },
});

export const listToolDescriptors = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("plugin_tools").withIndex("by_name").order("asc").take(400);
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
