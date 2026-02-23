import {
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUserId } from "./auth";

const conversationValidator = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.optional(v.string()),
  isDefault: v.boolean(),
  activeThreadId: v.optional(v.id("threads")),
  orchestratorReminderHash: v.optional(v.string()),
  orchestratorReminderThreadId: v.optional(v.id("threads")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const getById = internalQuery({
  args: { id: v.id("conversations") },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getOrCreateDefaultConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) {
      if (!existing.activeThreadId) {
        const threadId = await ctx.runMutation(internal.data.threads.createThread, {
          conversationId: existing._id,
          name: "Main",
        });
        await ctx.db.patch(existing._id, { activeThreadId: threadId });
        return await ctx.db.get(existing._id);
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "Default",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    const threadId = await ctx.runMutation(internal.data.threads.createThread, {
      conversationId: id,
      name: "Main",
    });
    
    await ctx.db.patch(id, { activeThreadId: threadId });

    const created = await ctx.db.get(id);
    return created;
  },
});

export const createConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "New conversation",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const threadId = await ctx.runMutation(internal.data.threads.createThread, {
      conversationId: id,
      name: "Main",
    });
    
    await ctx.db.patch(id, { activeThreadId: threadId });

    const created = await ctx.db.get(id);
    return created;
  },
});

export const getActiveThreadId = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(v.id("threads"), v.null()),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    return conversation?.activeThreadId ?? null;
  },
});

export const setActiveThreadId = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      activeThreadId: args.threadId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const markOrchestratorReminderSeen = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    threadId: v.id("threads"),
    reminderHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      orchestratorReminderHash: args.reminderHash,
      orchestratorReminderThreadId: args.threadId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

