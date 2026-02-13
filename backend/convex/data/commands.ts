import { v } from "convex/values";
import { mutation, internalQuery } from "../_generated/server";

/**
 * List enabled commands (catalog view: id, name, description, plugin).
 */
export const listCatalog = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      commandId: v.string(),
      name: v.string(),
      description: v.string(),
      pluginName: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("commands")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return rows.map((r) => ({
      commandId: r.commandId,
      name: r.name,
      description: r.description,
      pluginName: r.pluginName,
    }));
  },
});

/**
 * Get a single command by ID, including full content.
 */
export const getByCommandId = internalQuery({
  args: { commandId: v.string() },
  returns: v.union(
    v.object({
      commandId: v.string(),
      name: v.string(),
      description: v.string(),
      pluginName: v.string(),
      content: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("commands")
      .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
      .first();
    if (!row) return null;
    return {
      commandId: row.commandId,
      name: row.name,
      description: row.description,
      pluginName: row.pluginName,
      content: row.content,
    };
  },
});

/**
 * One-time bulk upsert of bundled commands.
 * Short-circuits if any command already exists (already seeded).
 */
export const upsertMany = mutation({
  args: {
    commands: v.array(
      v.object({
        commandId: v.string(),
        name: v.string(),
        description: v.string(),
        pluginName: v.string(),
        content: v.string(),
      }),
    ),
  },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, args) => {
    // Skip if already seeded
    const first = await ctx.db
      .query("commands")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .first();
    if (first) return { upserted: 0 };

    let upserted = 0;
    const now = Date.now();

    for (const cmd of args.commands) {
      await ctx.db.insert("commands", {
        commandId: cmd.commandId,
        name: cmd.name,
        description: cmd.description,
        pluginName: cmd.pluginName,
        content: cmd.content,
        enabled: true,
        updatedAt: now,
      });
      upserted++;
    }

    return { upserted };
  },
});
