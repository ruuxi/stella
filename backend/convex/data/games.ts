import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { ConvexError, v } from "convex/values";
import {
  requireSensitiveUserIdentityAction,
  requireUserId,
  requireSensitiveUserIdAction,
} from "../auth";
import { requireBoundedString } from "../shared_validators";
import { gameStatusValidator } from "../schema/games";
import { signHostedGameToken } from "../lib/game_auth";

const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 4;
const MAX_JOIN_CODE_RETRIES = 10;
const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const generateJoinCode = (): string => {
  const chars: string[] = [];
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * JOIN_CODE_ALPHABET.length);
    chars.push(JOIN_CODE_ALPHABET[index]);
  }
  return chars.join("");
};

const normalizeGameId = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  requireBoundedString(normalized, "gameId", 64);
  if (!GAME_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Game ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const isAnonymousIdentity = (
  identity: Awaited<ReturnType<typeof requireSensitiveUserIdentityAction>>,
): boolean => (identity as Record<string, unknown>).isAnonymous === true;

const getIdentityDisplayName = (
  identity: Awaited<ReturnType<typeof requireSensitiveUserIdentityAction>>,
): string => {
  const record = identity as Record<string, unknown>;
  const candidates = [
    record.name,
    record.nickname,
    record.email,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 120);
    }
  }
  return "Player";
};

type HostedGameAuthTokenResult = {
  gameId: string;
  joinCode: string;
  displayName: string;
  gameToken: string;
  expiresAt: number;
  spacetimeSessionId?: string;
};

type HostedGameLookupResult = {
  gameId: string;
  joinCode: string;
  deploymentPath?: string;
  status: "active" | "archived";
  spacetimeSessionId?: string;
} | null;

const getGameByGameId = async (
  ctx: QueryCtx | MutationCtx,
  gameId: string,
) =>
  await ctx.db
    .query("games")
    .withIndex("by_gameId", (q) => q.eq("gameId", gameId))
    .unique();

const getOwnedGame = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  gameId: string,
) =>
  await ctx.db
    .query("games")
    .withIndex("by_ownerId_and_gameId", (q) =>
      q.eq("ownerId", ownerId).eq("gameId", gameId),
    )
    .unique();

const findUniqueJoinCode = async (
  ctx: MutationCtx,
): Promise<string> => {
  for (let attempt = 0; attempt < MAX_JOIN_CODE_RETRIES; attempt++) {
    const code = generateJoinCode();
    const existing = await ctx.db
      .query("games")
      .withIndex("by_joinCode", (q) => q.eq("joinCode", code))
      .unique();
    if (!existing) {
      return code;
    }
  }
  throw new ConvexError({
    code: "INTERNAL",
    message: "Failed to generate a unique join code. Please try again.",
  });
};

// --- Internal mutations/queries ---

export const createGameRecord = internalMutation({
  args: {
    ownerId: v.string(),
    gameId: v.string(),
    displayName: v.string(),
    description: v.string(),
    gameType: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await getGameByGameId(ctx, args.gameId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "A game with this ID already exists.",
      });
    }

    const joinCode = await findUniqueJoinCode(ctx);
    const now = Date.now();

    const id = await ctx.db.insert("games", {
      ownerId: args.ownerId,
      gameId: args.gameId,
      displayName: args.displayName,
      description: args.description,
      gameType: args.gameType,
      joinCode,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return { _id: id, gameId: args.gameId, joinCode };
  },
});

export const updateGameDeployment = internalMutation({
  args: {
    ownerId: v.string(),
    gameId: v.string(),
    deploymentPath: v.string(),
    spacetimeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const game = await getOwnedGame(ctx, args.ownerId, args.gameId);
    if (!game) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Game not found.",
      });
    }

    await ctx.db.patch(game._id, {
      deploymentPath: args.deploymentPath,
      ...(args.spacetimeSessionId
        ? { spacetimeSessionId: args.spacetimeSessionId }
        : {}),
      updatedAt: Date.now(),
    });
  },
});

export const getGameByJoinCodeInternal = internalQuery({
  args: { joinCode: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("games")
      .withIndex("by_joinCode", (q) =>
        q.eq("joinCode", args.joinCode.toUpperCase().trim()),
      )
      .unique(),
});

export const getGameByGameIdInternal = internalQuery({
  args: { ownerId: v.string(), gameId: v.string() },
  handler: async (ctx, args) =>
    await getOwnedGame(ctx, args.ownerId, args.gameId),
});

export const getGameByPublicGameIdInternal = internalQuery({
  args: { gameId: v.string() },
  handler: async (ctx, args) =>
    await getGameByGameId(ctx, args.gameId),
});

export const recordGameAsset = internalMutation({
  args: {
    ownerId: v.string(),
    gameId: v.string(),
    path: v.string(),
    storageKey: v.id("_storage"),
    contentType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    // Upsert: delete existing asset at this path, then insert
    const existing = await ctx.db
      .query("game_assets")
      .withIndex("by_gameId_and_path", (q) =>
        q.eq("gameId", args.gameId).eq("path", args.path),
      )
      .unique();

    if (existing) {
      // Delete old storage blob
      await ctx.storage.delete(existing.storageKey);
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("game_assets", {
      ownerId: args.ownerId,
      gameId: args.gameId,
      path: args.path,
      storageKey: args.storageKey,
      contentType: args.contentType,
      size: args.size,
      createdAt: Date.now(),
    });
  },
});

export const getGameAsset = internalQuery({
  args: { gameId: v.string(), path: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("game_assets")
      .withIndex("by_gameId_and_path", (q) =>
        q.eq("gameId", args.gameId).eq("path", args.path),
      )
      .unique(),
});

export const cleanupGameAssets = internalMutation({
  args: { ownerId: v.string(), gameId: v.string() },
  handler: async (ctx, args) => {
    const assets = await ctx.db
      .query("game_assets")
      .withIndex("by_ownerId_and_gameId", (q) =>
        q.eq("ownerId", args.ownerId).eq("gameId", args.gameId),
      )
      .take(100);

    const promises = assets.map(async (asset) => {
      await ctx.storage.delete(asset.storageKey);
      await ctx.db.delete(asset._id);
    });
    await Promise.all(promises);

    if (assets.length === 100) {
      await ctx.scheduler.runAfter(0, internal.data.games.cleanupGameAssets, args);
    }
  },
});

// --- Public queries ---

export const listGames = query({
  args: {},
  returns: v.array(
    v.object({
      gameId: v.string(),
      displayName: v.string(),
      description: v.string(),
      gameType: v.string(),
      joinCode: v.string(),
      status: gameStatusValidator,
      deploymentPath: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const games = await ctx.db
      .query("games")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);

    return games.map((g) => ({
      gameId: g.gameId,
      displayName: g.displayName,
      description: g.description,
      gameType: g.gameType,
      joinCode: g.joinCode,
      status: g.status,
      deploymentPath: g.deploymentPath,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    }));
  },
});

export const getGame = query({
  args: { gameId: v.string() },
  returns: v.union(
    v.object({
      gameId: v.string(),
      displayName: v.string(),
      description: v.string(),
      gameType: v.string(),
      joinCode: v.string(),
      status: gameStatusValidator,
      deploymentPath: v.optional(v.string()),
      spacetimeSessionId: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const game = await getOwnedGame(ctx, ownerId, normalizeGameId(args.gameId));
    if (!game) return null;

    return {
      gameId: game.gameId,
      displayName: game.displayName,
      description: game.description,
      gameType: game.gameType,
      joinCode: game.joinCode,
      status: game.status,
      deploymentPath: game.deploymentPath,
      spacetimeSessionId: game.spacetimeSessionId,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    };
  },
});

export const getGameByJoinCode = query({
  args: { joinCode: v.string() },
  returns: v.union(
    v.object({
      gameId: v.string(),
      displayName: v.string(),
      gameType: v.string(),
      joinCode: v.string(),
      deploymentPath: v.optional(v.string()),
      spacetimeSessionId: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const code = args.joinCode.toUpperCase().trim();
    if (code.length !== JOIN_CODE_LENGTH) return null;

    const game = await ctx.db
      .query("games")
      .withIndex("by_joinCode", (q) => q.eq("joinCode", code))
      .unique();

    if (!game || game.status !== "active") return null;

    return {
      gameId: game.gameId,
      displayName: game.displayName,
      gameType: game.gameType,
      joinCode: game.joinCode,
      deploymentPath: game.deploymentPath,
      spacetimeSessionId: game.spacetimeSessionId,
    };
  },
});

export const archiveGame = mutation({
  args: { gameId: v.string() },
  returns: v.object({ archived: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const game = await getOwnedGame(ctx, ownerId, normalizeGameId(args.gameId));
    if (!game) return { archived: false };

    await ctx.db.patch(game._id, {
      status: "archived",
      updatedAt: Date.now(),
    });

    return { archived: true };
  },
});

// --- Actions (for operations that need storage or side effects) ---

export const deployGameBuild = action({
  args: {
    gameId: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
        contentType: v.string(),
        encoding: v.union(v.literal("utf8"), v.literal("base64")),
      }),
    ),
  },
  returns: v.object({
    gameId: v.string(),
    deploymentPath: v.string(),
    assetCount: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ gameId: string; deploymentPath: string; assetCount: number }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const gameId = normalizeGameId(args.gameId);

    // Verify the game exists and belongs to this user
    const existingGame: Awaited<ReturnType<typeof getOwnedGame>> = await ctx.runQuery(
      internal.data.games.getGameByGameIdInternal,
      { ownerId, gameId },
    );
    if (!existingGame) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Game not found. Create a game first.",
      });
    }

    // Clean up previous deployment assets
    await ctx.runMutation(internal.data.games.cleanupGameAssets, {
      ownerId,
      gameId,
    });

    // Upload each file to Convex storage
    const uploadPromises = args.files.map(async (file) => {
      const blobPart =
        file.encoding === "base64"
          ? Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0))
          : file.content;
      const blob = new Blob([blobPart], { type: file.contentType });
      const storageKey = await ctx.storage.store(blob);

      await ctx.runMutation(internal.data.games.recordGameAsset, {
        ownerId,
        gameId,
        path: file.path,
        storageKey,
        contentType: file.contentType,
        size: blob.size,
      });

      return blob.size;
    });

    const sizes = await Promise.all(uploadPromises);
    const totalSize = sizes.reduce((a, b) => a + b, 0);

    const deploymentPath = `/games/${gameId}`;

    // Update the game record with deployment info
    await ctx.runMutation(internal.data.games.updateGameDeployment, {
      ownerId,
      gameId,
      deploymentPath,
    });

    console.log(
      `[games] Deployed: gameId=${gameId} files=${args.files.length} totalSize=${totalSize}`,
    );

    return {
      gameId,
      deploymentPath,
      assetCount: args.files.length,
    };
  },
});

export const createGame = action({
  args: {
    gameId: v.string(),
    displayName: v.string(),
    description: v.string(),
    gameType: v.string(),
  },
  returns: v.object({
    gameId: v.string(),
    joinCode: v.string(),
  }),
  handler: async (ctx, args): Promise<{ gameId: string; joinCode: string }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const gameId = normalizeGameId(args.gameId);
    requireBoundedString(args.displayName, "displayName", 120);
    requireBoundedString(args.description, "description", 2000);
    requireBoundedString(args.gameType, "gameType", 64);

    const result: { gameId: string; joinCode: string } = await ctx.runMutation(
      internal.data.games.createGameRecord,
      {
        ownerId,
        gameId,
        displayName: args.displayName,
        description: args.description,
        gameType: args.gameType,
      },
    );

    return { gameId: result.gameId, joinCode: result.joinCode };
  },
});

export const issueHostedGameAuthToken = action({
  args: {
    gameId: v.optional(v.string()),
    joinCode: v.optional(v.string()),
  },
  returns: v.object({
    gameId: v.string(),
    joinCode: v.string(),
    displayName: v.string(),
    gameToken: v.string(),
    expiresAt: v.number(),
    spacetimeSessionId: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<HostedGameAuthTokenResult> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    if (isAnonymousIdentity(identity)) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Sign in with an account to join multiplayer games.",
      });
    }

    const normalizedGameId = args.gameId ? normalizeGameId(args.gameId) : null;
    const normalizedJoinCode = args.joinCode?.toUpperCase().trim() || null;
    if (!normalizedGameId && !normalizedJoinCode) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "A game ID or join code is required.",
      });
    }

    const game: HostedGameLookupResult = normalizedJoinCode
      ? await ctx.runQuery(internal.data.games.getGameByJoinCodeInternal, {
          joinCode: normalizedJoinCode,
        })
      : await ctx.runQuery(internal.data.games.getGameByPublicGameIdInternal, {
          gameId: normalizedGameId!,
        });

    if (!game || game.status !== "active" || !game.deploymentPath) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Game not found or not available to launch.",
      });
    }

    const displayName = getIdentityDisplayName(identity);
    const { token, payload } = await signHostedGameToken({
      userId: identity.subject,
      gameId: game.gameId,
      joinCode: game.joinCode,
      spacetimeSessionId: game.spacetimeSessionId,
      displayName,
    });

    return {
      gameId: game.gameId,
      joinCode: game.joinCode,
      displayName,
      gameToken: token,
      expiresAt: payload.exp,
      ...(game.spacetimeSessionId
        ? { spacetimeSessionId: game.spacetimeSessionId }
        : {}),
    };
  },
});
