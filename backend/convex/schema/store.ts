import { defineTable } from "convex/server";
import { v } from "convex/values";

// Reference to a parent add-on this release extends. Multi-parent
// arrays are supported because a single release can legitimately
// extend more than one installed add-on (e.g. a theme touching two).
export const store_release_parent_ref_validator = v.object({
  authorHandle: v.string(),
  packageId: v.string(),
  compatibleWithReleaseNumber: v.number(),
});

// Authored-against fingerprint hint. Used by the install agent to know
// roughly what surface area the release was built against. Not a hard
// gate — the install agent adapts to the local tree.
export const store_release_authored_against_validator = v.object({
  stellaCommit: v.optional(v.string()),
});

// Use a forward declaration: the manifest validator references
// `store_package_category_validator` defined further down. We could
// shuffle but inline-redefining here keeps adjacency.
const _release_manifest_category_validator = v.union(
  v.literal("apps-games"),
  v.literal("productivity"),
  v.literal("customization"),
  v.literal("skills-agents"),
  v.literal("integrations"),
  v.literal("other"),
);

export const store_release_manifest_validator = v.object({
  includedBatchIds: v.array(v.string()),
  includedCommitHashes: v.array(v.string()),
  changedFiles: v.array(v.string()),
  category: v.optional(_release_manifest_category_validator),
  artifactHash: v.optional(v.string()),
  summary: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  authorDisplayName: v.optional(v.string()),
  parent: v.optional(v.array(store_release_parent_ref_validator)),
  authoredAgainst: v.optional(store_release_authored_against_validator),
});

// Lightweight commit catalog entry (no patches, no file snapshots) — what
// the desktop hands the Store agent on every send so it can reason about
// recent self-mod changes without paying the bundle-upload cost.
export const store_thread_commit_validator = v.object({
  commitHash: v.string(),
  shortHash: v.string(),
  subject: v.string(),
  body: v.string(),
  timestampMs: v.number(),
  files: v.array(v.string()),
  fileCount: v.number(),
  // Feature-grouping metadata copied from the commit's `Stella-*`
  // trailers. Optional because legacy/non-grouped self-mod commits
  // predate the feature roster and won't carry these.
  featureId: v.optional(v.string()),
  parentPackageIds: v.optional(v.array(v.string())),
});

// One persisted message on a Store thread.
//   `draft`      — preview the user confirms (rendered as draft card)
//   `candidates` — multi-pick list when more than one commit could match
//                  the user's selection; the side panel renders a checklist
//                  and the user's pick comes back as a normal user turn
export const store_thread_message_role_validator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("draft"),
  v.literal("candidates"),
);

// Candidate shortlist payload for `role: "candidates"` rows. The agent
// supplies hashes; the side panel resolves them against the catalog the
// renderer holds (so we don't double-store fields the renderer already
// has). `reason` is shown as a one-line subtitle above the checklist.
export const store_thread_candidates_payload_validator = v.object({
  reason: v.string(),
  commitHashes: v.array(v.string()),
  // Stamped when the user submits their pick so the panel can render
  // the answered state (greyed checklist) instead of an active picker.
  resolvedAt: v.optional(v.number()),
  resolvedCommitHashes: v.optional(v.array(v.string())),
});

export const store_thread_draft_payload_validator = v.object({
  packageId: v.string(),
  category: _release_manifest_category_validator,
  displayName: v.string(),
  description: v.string(),
  releaseNotes: v.optional(v.string()),
  releaseNumber: v.number(),
  existingPackageId: v.optional(v.string()),
  commitHashes: v.array(v.string()),
  selectedChanges: v.array(v.object({
    commitHash: v.string(),
    shortHash: v.string(),
    subject: v.string(),
    files: v.array(v.string()),
  })),
  // Stamped on the draft message after the user confirms; used by the UI
  // to flip the draft card from "Confirm" to "Published vN" without a
  // separate assistant message.
  publishedAt: v.optional(v.number()),
  publishedReleaseNumber: v.optional(v.number()),
  cancelledAt: v.optional(v.number()),
});

// Broad, user-facing categories for browsing. The system never branches
// on category — it's a discovery hint only. Add-ons can also carry up
// to 5 free-form `tags` for sub-categorization.
export const store_package_category_validator = v.union(
  v.literal("apps-games"),
  v.literal("productivity"),
  v.literal("customization"),
  v.literal("skills-agents"),
  v.literal("integrations"),
  v.literal("other"),
);

const storePackageFields = {
  ownerId: v.string(),
  packageId: v.string(),
  category: v.optional(store_package_category_validator),
  tags: v.optional(v.array(v.string())),
  displayName: v.string(),
  description: v.string(),
  // Lowercased `displayName + " " + description` used as the searchField
  // for the public Discover search index. Refreshed whenever the
  // surface metadata changes; see `buildPackageSearchText` in
  // `data/store_packages.ts`.
  searchText: v.string(),
  latestReleaseNumber: v.number(),
  latestReleaseId: v.optional(v.id("store_package_releases")),
  createdAt: v.number(),
  updatedAt: v.number(),
  authorDisplayName: v.optional(v.string()),
  // Denormalized creator handle (`user_profiles.publicHandle`) so the
  // Discover/cards UI can render `/c/:handle` links without a second
  // round-trip per card. Stamped at publish time by `confirmDraft`.
  authorHandle: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  featured: v.optional(v.boolean()),
  featuredAt: v.optional(v.number()),
};

const storePackageReleaseFields = {
  ownerId: v.string(),
  packageRef: v.id("store_packages"),
  packageId: v.string(),
  releaseNumber: v.number(),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  artifactStorageKey: v.id("_storage"),
  artifactUrl: v.union(v.null(), v.string()),
  artifactContentType: v.string(),
  artifactSize: v.number(),
  createdAt: v.number(),
  parent: v.optional(v.array(store_release_parent_ref_validator)),
  authoredAgainst: v.optional(store_release_authored_against_validator),
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

// Single per-owner Store thread (one chat per user). Bundle and catalog
// are passed inline as action args every send — the thread row stays
// small and only tracks identity + the last-uploaded timestamp the side
// panel uses for its "catalog uploaded …" hint.
const storeThreadFields = {
  ownerId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
  commitCatalogUploadedAt: v.optional(v.number()),
};

const storeThreadMessageFields = {
  ownerId: v.string(),
  threadRef: v.id("store_threads"),
  role: store_thread_message_role_validator,
  text: v.string(),
  // Hashes the user explicitly attached to this message via sidebar chips.
  // The agent treats these as authoritative selections; without any chips
  // it falls back to inferring from the catalog.
  attachedCommitHashes: v.optional(v.array(v.string())),
  draftPayload: v.optional(store_thread_draft_payload_validator),
  candidatesPayload: v.optional(store_thread_candidates_payload_validator),
  // Set on the message inserted to capture an in-flight assistant turn.
  // Pending rows render as a "thinking" placeholder until the action
  // returns and patches `text`/`pending: false`.
  pending: v.optional(v.boolean()),
  createdAt: v.number(),
};

export const storeSchema = {
  store_packages: defineTable(storePackageFields)
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_packageId", ["ownerId", "packageId"])
    .index("by_packageId", ["packageId"])
    .index("by_featured_and_featuredAt", ["featured", "featuredAt"])
    // Public discovery: paginated browse by `updatedAt`, optionally
    // narrowed by category. Two indexes so we can pick the tighter
    // one based on whether the caller passed a category filter.
    .index("by_updatedAt", ["updatedAt"])
    .index("by_category_and_updatedAt", ["category", "updatedAt"])
    // Public Discover search. `searchText` is a denormalized lowercased
    // join of `displayName + description`, refreshed by
    // `data/store_packages.ts` whenever surface metadata changes.
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["category"],
    }),

  store_package_releases: defineTable(storePackageReleaseFields)
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_packageRef_and_releaseNumber", ["packageRef", "releaseNumber"])
    .index("by_packageId_and_releaseNumber", ["packageId", "releaseNumber"]),

  store_threads: defineTable(storeThreadFields)
    .index("by_ownerId", ["ownerId"]),

  store_thread_messages: defineTable(storeThreadMessageFields)
    .index("by_threadRef_and_createdAt", ["threadRef", "createdAt"]),
};
