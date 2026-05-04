import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { petCatalogItemValidator } from "../schema/pets";
import {
  RATE_HOT_PATH,
  RATE_STANDARD,
  enforceMutationRateLimit,
} from "../lib/rate_limits";

/** Public catalog rows always carry these display-safe fields. */
const publicPetValidator = v.object({
  id: v.string(),
  displayName: v.string(),
  description: v.string(),
  kind: v.string(),
  tags: v.array(v.string()),
  ownerName: v.union(v.string(), v.null()),
  spritesheetUrl: v.string(),
  sourceUrl: v.string(),
  previewUrl: v.optional(v.string()),
  sortOrder: v.number(),
  updatedAt: v.number(),
  downloads: v.number(),
});

/** Convex's PaginationResult shape, mirroring `data/store_packages` so
 *  the desktop client can use the same `usePaginatedQuery` typing. */
const paginatedPetsValidator = v.object({
  page: v.array(publicPetValidator),
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

/** Hard upper bound on page size to keep first paint snappy and stay
 *  well under the 8192 array-return cap even when callers ask for more. */
const MAX_PAGE_SIZE = 64;

const toPublicPet = (row: Doc<"pet_catalog">) => ({
  id: row.id,
  displayName: row.displayName,
  description: row.description,
  kind: row.kind,
  tags: row.tags,
  ownerName: row.ownerName,
  spritesheetUrl: row.spritesheetUrl,
  sourceUrl: row.sourceUrl,
  ...(row.previewUrl ? { previewUrl: row.previewUrl } : {}),
  sortOrder: row.sortOrder,
  updatedAt: row.updatedAt,
  downloads: row.downloads ?? 0,
});

const buildSearchText = (
  pet: Pick<Doc<"pet_catalog">, "displayName" | "description" | "ownerName">,
): string =>
  [pet.displayName, pet.description, pet.ownerName ?? ""]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");

const sortLiteral = v.union(v.literal("downloads"), v.literal("name"));

/**
 * Paginated public catalog. Picks the right index based on the requested
 * sort. When `tag` is set the read goes through the `pet_tag_membership`
 * junction so the index alone covers the page. When `search` is set the
 * Convex search index over `searchText` ranks by relevance and overrides
 * tag/sort (the same UX every marketplace uses — Algolia-style search).
 */
export const listPublicPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
    sort: sortLiteral,
    tag: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  returns: paginatedPetsValidator,
  handler: async (ctx, args) => {
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_PAGE_SIZE,
    );
    const opts = { cursor: args.paginationOpts.cursor, numItems };

    const trimmedSearch = args.search?.trim() ?? "";
    const trimmedTag = args.tag?.trim() ?? "";

    if (trimmedSearch.length > 0) {
      const result = await ctx.db
        .query("pet_catalog")
        .withSearchIndex("search_searchText", (q) =>
          q.search("searchText", trimmedSearch).eq("published", true),
        )
        .paginate(opts);
      return { ...result, page: result.page.map(toPublicPet) };
    }

    if (trimmedTag.length > 0) {
      const indexName =
        args.sort === "downloads"
          ? ("by_tagAndPublishedAndDownloads" as const)
          : ("by_tagAndPublishedAndDisplayName" as const);
      const order = args.sort === "downloads" ? "desc" : "asc";
      const junctionPage = await ctx.db
        .query("pet_tag_membership")
        .withIndex(indexName, (q) =>
          q.eq("tag", trimmedTag).eq("published", true),
        )
        .order(order)
        .paginate(opts);
      const pets = await Promise.all(
        junctionPage.page.map((row) => ctx.db.get(row.petId)),
      );
      return {
        ...junctionPage,
        page: pets
          .filter((pet): pet is Doc<"pet_catalog"> => pet !== null)
          .map(toPublicPet),
      };
    }

    const indexName =
      args.sort === "downloads"
        ? ("by_publishedAndDownloads" as const)
        : ("by_publishedAndDisplayName" as const);
    const order = args.sort === "downloads" ? "desc" : "asc";
    const result = await ctx.db
      .query("pet_catalog")
      .withIndex(indexName, (q) => q.eq("published", true))
      .order(order)
      .paginate(opts);
    return { ...result, page: result.page.map(toPublicPet) };
  },
});

/**
 * Per-id resolver used by the floating pet overlay so it can render the
 * selected pet without depending on the full catalog being in memory.
 * Returns `null` when the pet is missing or unpublished — the renderer
 * falls back to its bundled default in that case.
 */
export const getByPetId = query({
  args: { id: v.string() },
  returns: v.union(publicPetValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("pet_catalog")
      .withIndex("by_petId", (q) => q.eq("id", args.id))
      .unique();
    if (!row || !row.published) return null;
    return toPublicPet(row);
  },
});

/**
 * Resolve a batch of pets by their string ids in one call. Used by the
 * overlay/cache layer when restoring multiple recently-selected pets at
 * once after a cold start. Capped at a small batch so this can't be
 * abused as a "list everything" endpoint.
 */
const PET_BY_IDS_BATCH_LIMIT = 32;

export const getByPetIds = query({
  args: { ids: v.array(v.string()) },
  returns: v.array(publicPetValidator),
  handler: async (ctx, args) => {
    const ids = args.ids.slice(0, PET_BY_IDS_BATCH_LIMIT);
    const rows = await Promise.all(
      ids.map((id) =>
        ctx.db
          .query("pet_catalog")
          .withIndex("by_petId", (q) => q.eq("id", id))
          .unique(),
      ),
    );
    return rows
      .filter(
        (row): row is Doc<"pet_catalog"> => row !== null && row.published,
      )
      .map(toPublicPet);
  },
});

/** Hard cap on returned facet rows so the filter row read is always
 *  bounded, even when the catalog grows large in catalog-tag count. */
const MAX_FACETS = 256;

/**
 * Tag → published-pet count for the filter pill row. Sorted by count
 * descending so the most-populated tags surface first; reads from the
 * incrementally maintained `pet_tag_facets` table rather than scanning
 * the catalog on every render.
 */
export const listTagFacets = query({
  args: {},
  returns: v.array(
    v.object({
      tag: v.string(),
      count: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("pet_tag_facets")
      .withIndex("by_count")
      .order("desc")
      .take(MAX_FACETS);
    return rows.map((row) => ({ tag: row.tag, count: row.count }));
  },
});

/**
 * Public counter bump for "user picked this pet". Backend-enforced rate
 * limit because the desktop client is user-modifiable. Patches the
 * parent row plus every junction membership so the popularity-sorted
 * indexes stay coherent.
 */
export const incrementDownloads = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const rateKey = identity?.tokenIdentifier ?? `anon:${args.id}`;
    await enforceMutationRateLimit(
      ctx,
      "pets.incrementDownloads",
      rateKey,
      identity ? RATE_HOT_PATH : RATE_STANDARD,
    );
    const row = await ctx.db
      .query("pet_catalog")
      .withIndex("by_petId", (q) => q.eq("id", args.id))
      .unique();
    if (!row) return null;
    const nextDownloads = (row.downloads ?? 0) + 1;
    await ctx.db.patch(row._id, { downloads: nextDownloads });
    const memberships = await ctx.db
      .query("pet_tag_membership")
      .withIndex("by_petId", (q) => q.eq("petId", row._id))
      .collect();
    for (const m of memberships) {
      await ctx.db.patch(m._id, { downloads: nextDownloads });
    }
    return null;
  },
});

/**
 * Bulk upsert the public catalog. Maintains the tag junction and tag
 * facets incrementally so we never have to rescan the whole catalog —
 * each pet's tag delta translates to at most O(addedTags + removedTags)
 * facet patches.
 */
export const upsertMany = internalMutation({
  args: {
    pets: v.array(petCatalogItemValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const pet of args.pets) {
      const existing = await ctx.db
        .query("pet_catalog")
        .withIndex("by_petId", (q) => q.eq("id", pet.id))
        .unique();
      const downloads = Math.max(0, Math.floor(pet.downloads ?? existing?.downloads ?? 0));
      const searchText = buildSearchText(pet);
      let petDocId: Id<"pet_catalog">;
      if (existing) {
        await ctx.db.replace(existing._id, {
          ...pet,
          downloads,
          searchText,
        });
        petDocId = existing._id;
      } else {
        petDocId = await ctx.db.insert("pet_catalog", {
          ...pet,
          downloads: 0,
          searchText,
        });
      }

      const beforePublished =
        existing?.published === true ? new Set(existing.tags) : new Set<string>();
      const afterPublished = pet.published
        ? new Set(pet.tags)
        : new Set<string>();

      await syncTagMembership(
        ctx,
        petDocId,
        pet.id,
        pet.tags,
        pet.published,
        pet.displayName,
        downloads,
      );

      for (const tag of beforePublished) {
        if (!afterPublished.has(tag)) {
          await applyFacetDelta(ctx, tag, -1);
        }
      }
      for (const tag of afterPublished) {
        if (!beforePublished.has(tag)) {
          await applyFacetDelta(ctx, tag, 1);
        }
      }
    }
    return null;
  },
});

/**
 * Replace the membership rows for one pet so they exactly mirror the
 * pet's current tag set / display name / downloads. Bounded by the
 * pet's own tag count (a handful), so a `.collect()` on the pet's prior
 * memberships is safe.
 */
const syncTagMembership = async (
  ctx: MutationCtx,
  petDocId: Id<"pet_catalog">,
  petStringId: string,
  tags: string[],
  published: boolean,
  displayName: string,
  downloads: number,
): Promise<void> => {
  const previousMemberships = await ctx.db
    .query("pet_tag_membership")
    .withIndex("by_petId", (q) => q.eq("petId", petDocId))
    .collect();
  for (const row of previousMemberships) {
    await ctx.db.delete(row._id);
  }
  for (const tag of new Set(tags)) {
    await ctx.db.insert("pet_tag_membership", {
      petId: petDocId,
      petStringId,
      tag,
      published,
      displayName,
      downloads,
    });
  }
};

/**
 * Adjust the precomputed count for one tag. Inserts a new facet row on
 * first sighting; deletes when the count drops back to zero so the
 * filter pill row never lists empty tags.
 */
const applyFacetDelta = async (
  ctx: MutationCtx,
  tag: string,
  delta: number,
): Promise<void> => {
  const existing = await ctx.db
    .query("pet_tag_facets")
    .withIndex("by_tag", (q) => q.eq("tag", tag))
    .unique();
  if (!existing) {
    if (delta <= 0) return;
    await ctx.db.insert("pet_tag_facets", { tag, count: delta });
    return;
  }
  const next = existing.count + delta;
  if (next <= 0) {
    await ctx.db.delete(existing._id);
    return;
  }
  await ctx.db.patch(existing._id, { count: next });
};
