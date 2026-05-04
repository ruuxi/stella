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
  user_pet_validator,
  user_pet_visibility_validator,
} from "../schema/user_pets";
import { requireBoundedString } from "../shared_validators";

const MAX_PAGE_SIZE = 64;
const MAX_DISPLAY_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_PROMPT = 4_000;
const MAX_URL = 2_048;
const PET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

const paginatedUserPetsValidator = v.object({
  page: v.array(user_pet_validator),
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

const normalizePetId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "petId", 64);
  if (!PET_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Pet ID must use lowercase letters, numbers, hyphens, or underscores.",
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
  description: string;
  prompt?: string;
  authorDisplayName?: string;
}): string =>
  [
    args.displayName,
    args.description,
    args.prompt ?? "",
    args.authorDisplayName ?? "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const isVisibleTo = (
  row: Doc<"user_pets">,
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
  returns: paginatedUserPetsValidator,
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_PAGE_SIZE,
    );
    const opts = { cursor: args.paginationOpts.cursor, numItems };
    const search = args.search?.trim() ?? "";
    if (search.length > 0) {
      return await ctx.db
        .query("user_pets")
        .withSearchIndex("search_text", (q) =>
          q.search("searchText", search).eq("visibility", "public"),
        )
        .paginate(opts);
    }
    return await ctx.db
      .query("user_pets")
      .withIndex("by_visibility_and_updatedAt", (q) =>
        q.eq("visibility", "public"),
      )
      .order("desc")
      .paginate(opts);
  },
});

export const listMine = query({
  args: {},
  returns: v.array(user_pet_validator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) return [];
    return await ctx.db
      .query("user_pets")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(256);
  },
});

export const getByPetId = query({
  args: { petId: v.string() },
  returns: v.union(user_pet_validator, v.null()),
  handler: async (ctx, args): Promise<Doc<"user_pets"> | null> => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    const petId = normalizePetId(args.petId);
    const row = await ctx.db
      .query("user_pets")
      .withIndex("by_petId", (q) => q.eq("petId", petId))
      .unique();
    if (!row || !isVisibleTo(row, ownerId)) return null;
    return row;
  },
});

export const createPet = mutation({
  args: {
    petId: v.string(),
    displayName: v.string(),
    description: v.string(),
    prompt: v.optional(v.string()),
    spritesheetUrl: v.string(),
    previewUrl: v.optional(v.string()),
    visibility: user_pet_visibility_validator,
  },
  returns: user_pet_validator,
  handler: async (ctx, args): Promise<Doc<"user_pets">> => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "userPets.createPet",
      ownerId,
      RATE_STANDARD,
    );
    const petId = normalizePetId(args.petId);
    const existing = await ctx.db
      .query("user_pets")
      .withIndex("by_petId", (q) => q.eq("petId", petId))
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "A pet with this ID already exists.",
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
    const description = normalizeRequiredText(
      args.description,
      "description",
      MAX_DESCRIPTION,
    );
    const prompt = normalizeOptionalText(args.prompt, "prompt", MAX_PROMPT);
    const spritesheetUrl = normalizeUrl(args.spritesheetUrl, "spritesheetUrl");
    const previewUrl = args.previewUrl
      ? normalizeUrl(args.previewUrl, "previewUrl")
      : undefined;
    const authorDisplayName = profile.nickname.trim();
    const authorHandle = profile.publicHandle.trim().toLowerCase();
    const now = Date.now();
    const id: Id<"user_pets"> = await ctx.db.insert("user_pets", {
      ownerId,
      petId,
      displayName,
      description,
      ...(prompt ? { prompt } : {}),
      spritesheetUrl,
      ...(previewUrl ? { previewUrl } : {}),
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
    const row = await ctx.db.get(id);
    if (!row) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Pet was not created.",
      });
    }
    return row;
  },
});

export const setVisibility = mutation({
  args: {
    petId: v.string(),
    visibility: user_pet_visibility_validator,
  },
  returns: user_pet_validator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const petId = normalizePetId(args.petId);
    const row = await ctx.db
      .query("user_pets")
      .withIndex("by_ownerId_and_petId", (q) =>
        q.eq("ownerId", ownerId).eq("petId", petId),
      )
      .unique();
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Pet not found.",
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
        message: "Pet not found.",
      });
    }
    return next;
  },
});

export const deletePet = mutation({
  args: { petId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const petId = normalizePetId(args.petId);
    const row = await ctx.db
      .query("user_pets")
      .withIndex("by_ownerId_and_petId", (q) =>
        q.eq("ownerId", ownerId).eq("petId", petId),
      )
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return null;
  },
});

export const recordInstall = mutation({
  args: { petId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "userPets.recordInstall",
      ownerId,
      RATE_HOT_PATH,
    );
    const petId = normalizePetId(args.petId);
    const row = await ctx.db
      .query("user_pets")
      .withIndex("by_petId", (q) => q.eq("petId", petId))
      .unique();
    if (!row || !isVisibleTo(row, ownerId)) return null;
    await ctx.db.patch(row._id, {
      installCount: (row.installCount ?? 0) + 1,
    });
    return null;
  },
});
