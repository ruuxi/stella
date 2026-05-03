import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  RATE_HOT_PATH,
  RATE_STANDARD,
  enforceMutationRateLimit,
} from "../lib/rate_limits";
import {
  emoji_pack_validator,
  emoji_pack_visibility_validator,
} from "../schema/emoji_packs";
import { requireBoundedString } from "../shared_validators";

const MAX_PAGE_SIZE = 64;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_PROMPT = 2_000;
const MAX_URL = 2_048;
const PACK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

const paginatedEmojiPacksValidator = v.object({
  page: v.array(emoji_pack_validator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(
      v.literal("SplitRecommended"),
      v.literal("SplitRequired"),
      v.null(),
    ),
  ),
});

const normalizePackId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packId", 64);
  if (!PACK_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Pack ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeRequiredText = (
  value: string,
  fieldName: string,
  maxLength: number,
): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} is required`,
    });
  }
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeOptionalText = (
  value: string | undefined,
  fieldName: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeUrl = (value: string, fieldName: string): string => {
  const normalized = normalizeRequiredText(value, fieldName, MAX_URL);
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:") {
      throw new Error("not https");
    }
  } catch {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} must be a valid HTTPS URL`,
    });
  }
  return normalized;
};

const buildSearchText = (args: {
  displayName: string;
  description?: string;
  prompt?: string;
  authorDisplayName?: string;
}): string =>
  [
    args.displayName,
    args.description ?? "",
    args.prompt ?? "",
    args.authorDisplayName ?? "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const toOwnedPack = (row: Doc<"emoji_packs">) => row;

const isVisibleTo = (
  row: Doc<"emoji_packs">,
  ownerId: string | null,
): boolean => {
  if (row.visibility === "public" || row.visibility === "unlisted") return true;
  return ownerId !== null && row.ownerId === ownerId;
};

export const listPublicPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: paginatedEmojiPacksValidator,
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_PAGE_SIZE,
    );
    const opts = { cursor: args.paginationOpts.cursor, numItems };
    const search = args.search?.trim() ?? "";
    if (search.length > 0) {
      const result = await ctx.db
        .query("emoji_packs")
        .withSearchIndex("search_text", (q) =>
          q.search("searchText", search).eq("visibility", "public"),
        )
        .paginate(opts);
      return result;
    }
    return await ctx.db
      .query("emoji_packs")
      .withIndex("by_visibility_and_updatedAt", (q) =>
        q.eq("visibility", "public"),
      )
      .order("desc")
      .paginate(opts);
  },
});

export const listMine = query({
  args: {},
  returns: v.array(emoji_pack_validator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) return [];
    const rows = await ctx.db
      .query("emoji_packs")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(256);
    return rows.map(toOwnedPack);
  },
});

export const getByPackId = query({
  args: { packId: v.string() },
  returns: v.union(emoji_pack_validator, v.null()),
  handler: async (ctx, args): Promise<Doc<"emoji_packs"> | null> => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    const packId = normalizePackId(args.packId);
    const row = await ctx.db
      .query("emoji_packs")
      .withIndex("by_packId", (q) => q.eq("packId", packId))
      .unique();
    if (!row || !isVisibleTo(row, ownerId)) return null;
    return row;
  },
});

export const createPack = mutation({
  args: {
    packId: v.string(),
    displayName: v.string(),
    description: v.optional(v.string()),
    prompt: v.optional(v.string()),
    coverEmoji: v.string(),
    sheet1Url: v.string(),
    sheet2Url: v.string(),
    visibility: emoji_pack_visibility_validator,
  },
  returns: emoji_pack_validator,
  handler: async (ctx, args): Promise<Doc<"emoji_packs">> => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "emojiPacks.createPack",
      ownerId,
      RATE_STANDARD,
    );
    const packId = normalizePackId(args.packId);
    const existing = await ctx.db
      .query("emoji_packs")
      .withIndex("by_packId", (q) => q.eq("packId", packId))
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "An emoji pack with this ID already exists.",
      });
    }
    const profile: { publicHandle: string; nickname: string } =
      await ctx.runMutation(
      internal.social.profiles.ensureProfileForOwnerInternal,
      { ownerId },
    );
    const displayName = normalizeRequiredText(
      args.displayName,
      "displayName",
      MAX_DISPLAY_NAME,
    );
    const description = normalizeOptionalText(
      args.description,
      "description",
      MAX_DESCRIPTION,
    );
    const prompt = normalizeOptionalText(args.prompt, "prompt", MAX_PROMPT);
    const coverEmoji = normalizeRequiredText(args.coverEmoji, "coverEmoji", 16);
    const sheet1Url = normalizeUrl(args.sheet1Url, "sheet1Url");
    const sheet2Url = normalizeUrl(args.sheet2Url, "sheet2Url");
    const authorDisplayName = profile.nickname.trim();
    const authorHandle = profile.publicHandle.trim().toLowerCase();
    const now = Date.now();
    const id: Id<"emoji_packs"> = await ctx.db.insert("emoji_packs", {
      ownerId,
      packId,
      displayName,
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      coverEmoji,
      sheet1Url,
      sheet2Url,
      visibility: args.visibility,
      searchText: buildSearchText({
        displayName,
        description,
        prompt,
        authorDisplayName,
      }),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      ...(authorHandle ? { authorHandle } : {}),
      installCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const row: Doc<"emoji_packs"> | null = await ctx.db.get(id);
    if (!row) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Emoji pack was not created.",
      });
    }
    return row;
  },
});

export const setVisibility = mutation({
  args: {
    packId: v.string(),
    visibility: emoji_pack_visibility_validator,
  },
  returns: emoji_pack_validator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const packId = normalizePackId(args.packId);
    const row = await ctx.db
      .query("emoji_packs")
      .withIndex("by_ownerId_and_packId", (q) =>
        q.eq("ownerId", ownerId).eq("packId", packId),
      )
      .unique();
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Emoji pack not found.",
      });
    }
    await ctx.db.patch(row._id, {
      visibility: args.visibility,
      updatedAt: Date.now(),
    });
    const next = await ctx.db.get(row._id);
    if (!next) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Emoji pack not found.",
      });
    }
    return next;
  },
});

export const deletePack = mutation({
  args: { packId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const packId = normalizePackId(args.packId);
    const row = await ctx.db
      .query("emoji_packs")
      .withIndex("by_ownerId_and_packId", (q) =>
        q.eq("ownerId", ownerId).eq("packId", packId),
      )
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return null;
  },
});

export const recordInstall = mutation({
  args: { packId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "emojiPacks.recordInstall",
      ownerId,
      RATE_HOT_PATH,
    );
    const packId = normalizePackId(args.packId);
    const row = await ctx.db
      .query("emoji_packs")
      .withIndex("by_packId", (q) => q.eq("packId", packId))
      .unique();
    if (!row || !isVisibleTo(row, ownerId)) return null;
    await ctx.db.patch(row._id, {
      installCount: (row.installCount ?? 0) + 1,
    });
    return null;
  },
});
