import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Wire format accepted by the seed HTTP route. The runtime `pet_catalog`
 * row carries derived fields (`searchText`, `downloads`) that the
 * external Codex Pet Share doesn't ship, so the seed validator is a
 * tighter subset that the upsert mutation enriches before insert.
 */
export const petCatalogItemValidator = v.object({
  id: v.string(),
  displayName: v.string(),
  description: v.string(),
  kind: v.string(),
  tags: v.array(v.string()),
  ownerName: v.union(v.string(), v.null()),
  spritesheetUrl: v.string(),
  sourceUrl: v.string(),
  published: v.boolean(),
  sortOrder: v.number(),
  updatedAt: v.number(),
});

export const petsSchema = {
  /**
   * Public pet catalog. Each row is one pickable pet sprite. The catalog is
   * paginated server-side via `data/pets.listPublicPage` — there are three
   * indexes covering the supported sort orders (popularity, alphabetical)
   * and a Convex search index for name/description/creator search.
   */
  pet_catalog: defineTable({
    id: v.string(),
    displayName: v.string(),
    description: v.string(),
    kind: v.string(),
    tags: v.array(v.string()),
    ownerName: v.union(v.string(), v.null()),
    spritesheetUrl: v.string(),
    sourceUrl: v.string(),
    published: v.boolean(),
    sortOrder: v.number(),
    updatedAt: v.number(),
    /** Public selection counter — bumped from `incrementDownloads` and
     *  read by the "Most popular" sort. Optional only so existing dev
     *  deployment rows can validate before the next seed refresh rewrites
     *  them with this derived field. */
    downloads: v.optional(v.number()),
    /** Concatenated `displayName + description + ownerName` rebuilt on
     *  every upsert. Convex search indexes only support a single
     *  `searchField`, so this denormalized blob lets the UI search across
     *  every human-visible string with one index. */
    searchText: v.optional(v.string()),
  })
    .index("by_petId", ["id"])
    .index("by_publishedAndDownloads", ["published", "downloads"])
    .index("by_publishedAndDisplayName", ["published", "displayName"])
    .searchIndex("search_searchText", {
      searchField: "searchText",
      filterFields: ["published"],
    }),

  /**
   * Junction row per (pet, tag) so paginating "all published pets with
   * tag X sorted by popularity" is one indexed scan. Mirrors the parent
   * pet's `displayName` / `downloads` / `published` so the index alone
   * answers the page without joining back into `pet_catalog` for sort.
   * Maintained inside `upsertMany` and `incrementDownloads`.
   */
  pet_tag_membership: defineTable({
    petId: v.id("pet_catalog"),
    petStringId: v.string(),
    tag: v.string(),
    published: v.boolean(),
    displayName: v.string(),
    downloads: v.number(),
  })
    .index("by_petId", ["petId"])
    .index("by_tagAndPublishedAndDownloads", [
      "tag",
      "published",
      "downloads",
    ])
    .index("by_tagAndPublishedAndDisplayName", [
      "tag",
      "published",
      "displayName",
    ]),

  /**
   * Precomputed `tag → published-pet count` for the filter pill row. The
   * sidebar reads this in O(facet) instead of scanning the catalog on
   * every load. Counts are kept in sync incrementally inside
   * `upsertMany` (no cron needed at this scale).
   */
  pet_tag_facets: defineTable({
    tag: v.string(),
    count: v.number(),
  })
    .index("by_tag", ["tag"])
    .index("by_count", ["count"]),
};
