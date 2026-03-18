import { defineTable } from "convex/server";
import { v } from "convex/values";

export const gameStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
);

export const gamesSchema = {
  games: defineTable({
    ownerId: v.string(),
    gameId: v.string(),
    displayName: v.string(),
    description: v.string(),
    gameType: v.string(),
    joinCode: v.string(),
    spacetimeSessionId: v.optional(v.string()),
    deploymentPath: v.optional(v.string()),
    status: gameStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_gameId", ["ownerId", "gameId"])
    .index("by_joinCode", ["joinCode"])
    .index("by_gameId", ["gameId"]),

  game_assets: defineTable({
    ownerId: v.string(),
    gameId: v.string(),
    path: v.string(),
    storageKey: v.id("_storage"),
    contentType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_gameId_and_path", ["gameId", "path"])
    .index("by_ownerId_and_gameId", ["ownerId", "gameId"]),
};
