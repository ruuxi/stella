import { v } from "convex/values";
import { mutation, internalQuery } from "../_generated/server";
import { requireUserId } from "../auth";

/**
 * List enabled commands (catalog view: id, name, description, plugin).
 */
export const listCatalog = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("commands")
      .withIndex("by_enabled_and_updatedAt", (q) => q.eq("enabled", true))
      .take(500);
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
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("commands")
      .withIndex("by_commandId", (q) => q.eq("commandId", args.commandId))
      .unique();
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
    await requireUserId(ctx);

    // Skip if already seeded
    const [firstEnabled, firstDisabled] = await Promise.all([
      ctx.db
        .query("commands")
        .withIndex("by_enabled_and_updatedAt", (q) => q.eq("enabled", true))
        .unique(),
      ctx.db
        .query("commands")
        .withIndex("by_enabled_and_updatedAt", (q) => q.eq("enabled", false))
        .unique(),
    ]);
    if (firstEnabled || firstDisabled) return { upserted: 0 };

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
