import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
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
const MAX_FACETS = 256;
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

const emojiPackSortValidator = v.union(v.literal("installs"), v.literal("name"));

const generatedMetadataValidator = v.object({
  displayName: v.string(),
  description: v.optional(v.string()),
  tags: v.array(v.string()),
  searchText: v.string(),
  updatedAt: v.number(),
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
  tags: string[];
  prompt?: string;
  authorDisplayName?: string;
}): string =>
  [
    args.displayName,
    args.description ?? "",
    ...args.tags,
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
    sort: v.optional(emojiPackSortValidator),
    tag: v.optional(v.string()),
  },
  returns: paginatedEmojiPacksValidator,
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_PAGE_SIZE,
    );
    const opts = { cursor: args.paginationOpts.cursor, numItems };
    const search = args.search?.trim() ?? "";
    const tag = args.tag?.trim().toLowerCase() ?? "";
    if (search.length > 0) {
      const result = await ctx.db
        .query("emoji_packs")
        .withSearchIndex("search_text", (q) =>
          q.search("searchText", search).eq("visibility", "public"),
        )
        .paginate(opts);
      return result;
    }
    if (tag.length > 0) {
      const sort = args.sort ?? "installs";
      const indexName =
        sort === "installs"
          ? ("by_tag_and_visibility_and_installCount" as const)
          : ("by_tag_and_visibility_and_displayName" as const);
      const page = await ctx.db
        .query("emoji_pack_tag_membership")
        .withIndex(indexName, (q) =>
          q.eq("tag", tag).eq("visibility", "public"),
        )
        .order(sort === "installs" ? "desc" : "asc")
        .paginate(opts);
      const packs = await Promise.all(
        page.page.map((row) => ctx.db.get(row.packRef)),
      );
      return {
        ...page,
        page: packs.filter(
          (pack): pack is Doc<"emoji_packs"> =>
            pack !== null && pack.visibility === "public",
        ),
      };
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

export const listTagFacets = query({
  args: {},
  returns: v.array(v.object({ tag: v.string(), count: v.number() })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("emoji_pack_tag_facets")
      .withIndex("by_count")
      .order("desc")
      .take(MAX_FACETS);
    return rows.map((row) => ({ tag: row.tag, count: row.count }));
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

export const getByIdInternal = internalQuery({
  args: { packId: v.id("emoji_packs") },
  returns: v.union(emoji_pack_validator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.packId);
  },
});

export const patchGeneratedMetadata = internalMutation({
  args: {
    packId: v.id("emoji_packs"),
    metadata: generatedMetadataValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.packId);
    if (!row) return null;
    await syncTagMembership(ctx, row, args.metadata.tags, {
      visibility: row.visibility,
      displayName: args.metadata.displayName,
      installCount: row.installCount ?? 0,
    });
    await ctx.db.patch(args.packId, args.metadata);
    return null;
  },
});

export const createPack = mutation({
  args: {
    packId: v.string(),
    displayName: v.string(),
    description: v.optional(v.string()),
    prompt: v.optional(v.string()),
    coverEmoji: v.string(),
    coverUrl: v.optional(v.string()),
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
    const coverUrl = args.coverUrl
      ? normalizeUrl(args.coverUrl, "coverUrl")
      : undefined;
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
      tags: [],
      ...(prompt ? { prompt } : {}),
      coverEmoji,
      ...(coverUrl ? { coverUrl } : {}),
      sheet1Url,
      sheet2Url,
      visibility: args.visibility,
      searchText: buildSearchText({
        displayName,
        description,
        tags: [],
        prompt,
        authorDisplayName,
      }),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      ...(authorHandle ? { authorHandle } : {}),
      installCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.data.store_asset_metadata.enrichEmojiPack,
      { packId: id },
    );
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
    await syncTagMembership(ctx, row, row.tags, {
      visibility: args.visibility,
      displayName: row.displayName,
      installCount: row.installCount ?? 0,
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
    const nextInstallCount = (row.installCount ?? 0) + 1;
    await ctx.db.patch(row._id, { installCount: nextInstallCount });
    const memberships = await ctx.db
      .query("emoji_pack_tag_membership")
      .withIndex("by_packRef", (q) => q.eq("packRef", row._id))
      .take(MAX_TAGS_PER_PACK);
    for (const membership of memberships) {
      await ctx.db.patch(membership._id, { installCount: nextInstallCount });
    }
    return null;
  },
});

const MAX_TAGS_PER_PACK = 8;

const syncTagMembership = async (
  ctx: MutationCtx,
  row: Doc<"emoji_packs">,
  nextTags: string[],
  next: {
    visibility: Doc<"emoji_packs">["visibility"];
    displayName: string;
    installCount: number;
  },
): Promise<void> => {
  const previousRows = await ctx.db
    .query("emoji_pack_tag_membership")
    .withIndex("by_packRef", (q) => q.eq("packRef", row._id))
    .take(MAX_TAGS_PER_PACK);
  const previousPublicTags =
    row.visibility === "public" ? new Set(previousRows.map((r) => r.tag)) : new Set<string>();
  const nextPublicTags =
    next.visibility === "public" ? new Set(nextTags.slice(0, MAX_TAGS_PER_PACK)) : new Set<string>();

  for (const membership of previousRows) {
    await ctx.db.delete(membership._id);
  }
  for (const tag of nextTags.slice(0, MAX_TAGS_PER_PACK)) {
    await ctx.db.insert("emoji_pack_tag_membership", {
      packRef: row._id,
      packId: row.packId,
      tag,
      visibility: next.visibility,
      displayName: next.displayName,
      installCount: next.installCount,
    });
  }
  for (const tag of previousPublicTags) {
    if (!nextPublicTags.has(tag)) await applyFacetDelta(ctx, tag, -1);
  }
  for (const tag of nextPublicTags) {
    if (!previousPublicTags.has(tag)) await applyFacetDelta(ctx, tag, 1);
  }
};

const applyFacetDelta = async (
  ctx: MutationCtx,
  tag: string,
  delta: number,
): Promise<void> => {
  const existing = await ctx.db
    .query("emoji_pack_tag_facets")
    .withIndex("by_tag", (q) => q.eq("tag", tag))
    .unique();
  if (!existing) {
    if (delta <= 0) return;
    await ctx.db.insert("emoji_pack_tag_facets", { tag, count: delta });
    return;
  }
  const next = existing.count + delta;
  if (next <= 0) {
    await ctx.db.delete(existing._id);
    return;
  }
  await ctx.db.patch(existing._id, { count: next });
};
