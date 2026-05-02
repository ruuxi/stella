import { defineTable } from "convex/server";
import { v } from "convex/values";

// ── Categories + visibility ──────────────────────────────────────────────────

export const store_package_visibility_validator = v.union(
  v.literal("public"),
  v.literal("unlisted"),
  v.literal("private"),
);

export const store_package_category_validator = v.union(
  v.literal("apps-games"),
  v.literal("productivity"),
  v.literal("customization"),
  v.literal("skills-agents"),
  v.literal("integrations"),
  v.literal("other"),
);

// Slim release manifest. The release payload itself is the blueprint
// markdown stored alongside; this manifest just carries display
// metadata + an optional `authoredAtCommit` hint.
export const store_release_manifest_validator = v.object({
  category: v.optional(store_package_category_validator),
  summary: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  authorDisplayName: v.optional(v.string()),
  authoredAtCommit: v.optional(v.string()),
});

// Per-commit reference diff. The author's tree authored these; the
// installer's tree may have diverged, so the install agent reads them
// as a strong default rather than a literal patch. `diff` is the raw
// `git show -U10` output post-redaction (home-dir paths, usernames,
// and obvious credential shapes scrubbed).
export const store_release_commit_validator = v.object({
  hash: v.string(),
  subject: v.string(),
  diff: v.string(),
});

// ── Packages + releases ──────────────────────────────────────────────────────

const storePackageFields = {
  ownerId: v.string(),
  packageId: v.string(),
  category: v.optional(store_package_category_validator),
  tags: v.optional(v.array(v.string())),
  displayName: v.string(),
  description: v.string(),
  searchText: v.string(),
  latestReleaseNumber: v.number(),
  latestReleaseId: v.optional(v.id("store_package_releases")),
  createdAt: v.number(),
  updatedAt: v.number(),
  authorDisplayName: v.optional(v.string()),
  authorHandle: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  featured: v.optional(v.boolean()),
  featuredAt: v.optional(v.number()),
  visibility: v.optional(store_package_visibility_validator),
  installCount: v.optional(v.number()),
};

const storePackageReleaseFields = {
  ownerId: v.string(),
  packageRef: v.id("store_packages"),
  packageId: v.string(),
  releaseNumber: v.number(),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  // The receiving general agent reads this markdown as the behaviour
  // spec for the release. The actual implementation is reference
  // diffs in `commits` — the installer's tree may have diverged from
  // the author's tree, so the agent treats those diffs as a strong
  // default rather than a literal patch.
  blueprintMarkdown: v.string(),
  commits: v.optional(v.array(store_release_commit_validator)),
  createdAt: v.number(),
};

export const store_package_validator = v.object({
  _id: v.id("store_packages"),
  _creationTime: v.number(),
  ...storePackageFields,
});

export const store_package_release_validator = v.object({
  _id: v.id("store_package_releases"),
  _creationTime: v.number(),
  ...storePackageReleaseFields,
});

export const store_publish_result_validator = v.object({
  package: store_package_validator,
  release: store_package_release_validator,
});

// ── Schema export ────────────────────────────────────────────────────────────

export const storeSchema = {
  store_packages: defineTable(storePackageFields)
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_packageId", ["ownerId", "packageId"])
    .index("by_packageId", ["packageId"])
    .index("by_featured_and_featuredAt", ["featured", "featuredAt"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_category_and_updatedAt", ["category", "updatedAt"])
    .index("by_visibility_and_updatedAt", ["visibility", "updatedAt"])
    .index("by_visibility_and_category_and_updatedAt", [
      "visibility",
      "category",
      "updatedAt",
    ])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["category", "visibility"],
    }),

  store_package_releases: defineTable(storePackageReleaseFields)
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_packageRef_and_releaseNumber", ["packageRef", "releaseNumber"])
    .index("by_packageId_and_releaseNumber", ["packageId", "releaseNumber"]),
};
