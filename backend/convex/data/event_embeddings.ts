import { v } from "convex/values";
import { embed } from "ai";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getModelConfig } from "../agent/model";

const eventEmbeddingValidator = v.object({
  _id: v.id("event_embeddings"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  eventId: v.id("events"),
  type: v.union(v.literal("user_message"), v.literal("assistant_message")),
  content: v.string(),
  timestamp: v.number(),
  embedding: v.array(v.float64()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

async function embedText(text: string): Promise<number[]> {
  const config = getModelConfig("event_semantic_embedding");
  const { embedding } = await embed({
    ...config,
    value: text,
  });
  return embedding;
}

export const getByEventId = internalQuery({
  args: {
    eventId: v.id("events"),
  },
  returns: v.union(eventEmbeddingValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("event_embeddings")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
  },
});

export const getEmbeddingsByIds = internalQuery({
  args: {
    ids: v.array(v.id("event_embeddings")),
  },
  returns: v.array(eventEmbeddingValidator),
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter((doc): doc is NonNullable<typeof doc> => !!doc);
  },
});

export const upsertEventEmbedding = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    eventId: v.id("events"),
    type: v.union(v.literal("user_message"), v.literal("assistant_message")),
    content: v.string(),
    timestamp: v.number(),
    embedding: v.array(v.float64()),
  },
  returns: v.id("event_embeddings"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("event_embeddings")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        type: args.type,
        content: args.content,
        timestamp: args.timestamp,
        embedding: args.embedding,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("event_embeddings", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      eventId: args.eventId,
      type: args.type,
      content: args.content,
      timestamp: args.timestamp,
      embedding: args.embedding,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const indexEventForSemanticSearch = internalAction({
  args: {
    eventId: v.id("events"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.runQuery(internal.events.getById, {
      id: args.eventId,
    });
    if (!event) {
      return null;
    }
    if (event.type !== "user_message" && event.type !== "assistant_message") {
      return null;
    }

    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as { text?: unknown })
        : {};
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return null;
    }

    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: event.conversationId,
    });
    if (!conversation) {
      return null;
    }

    const vector = await embedText(text);
    await ctx.runMutation(internal.data.event_embeddings.upsertEventEmbedding, {
      ownerId: conversation.ownerId,
      conversationId: event.conversationId,
      eventId: event._id as Id<"events">,
      type: event.type,
      content: text,
      timestamp: event.timestamp,
      embedding: vector,
    });
    return null;
  },
});
