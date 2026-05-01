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
};

const storePackageReleaseFields = {
  ownerId: v.string(),
  packageRef: v.id("store_packages"),
  packageId: v.string(),
  releaseNumber: v.number(),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  // The receiving general agent reads this markdown directly. No
  // patches, no file snapshots — the receiver adapts the blueprint
  // to its own codebase.
  blueprintMarkdown: v.string(),
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

// ── Store agent thread ───────────────────────────────────────────────────────

export const store_thread_message_role_validator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system_event"),
);

const storeThreadFields = {
  ownerId: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

const storeThreadMessageFields = {
  ownerId: v.string(),
  threadRef: v.id("store_threads"),
  role: store_thread_message_role_validator,
  text: v.string(),
  /**
   * Marks an assistant message as a publish-ready blueprint draft.
   * The most recent non-denied message with this flag is what the
   * Publish button targets and what `sendMessage` injects as
   * refinement context for the next agent turn.
   */
  isBlueprint: v.optional(v.boolean()),
  /**
   * User clicked Deny on this draft. The badge stays in chat (struck
   * through) so refinements don't lose narrative; the publish lookup
   * and the prepend path skip denied drafts and walk back to the
   * previous publishable one (if any).
   */
  denied: v.optional(v.boolean()),
  /**
   * Set after a successful publish so the same draft cannot be
   * published again as another release.
   */
  published: v.optional(v.boolean()),
  publishedReleaseNumber: v.optional(v.number()),
  /** Pending placeholder while the agent loop is still streaming. */
  pending: v.optional(v.boolean()),
  /**
   * Selected feature names the user attached when sending this turn.
   * Display-only; the agent only sees the names, never commit hashes.
   */
  attachedFeatureNames: v.optional(v.array(v.string())),
  /**
   * Set on user messages where the user hit Edit on a blueprint draft
   * before typing. The agent's opening-message framing flips to
   * "refine the existing draft" when this is true.
   */
  editingBlueprint: v.optional(v.boolean()),
  createdAt: v.number(),
};

export const store_thread_message_validator = v.object({
  _id: v.id("store_thread_messages"),
  _creationTime: v.number(),
  ...storeThreadMessageFields,
});

// ── Pending tool-call queue ──────────────────────────────────────────────────
//
// The Convex agent loop runs server-side with a fixed system prompt
// and tool registry. When the model wants to read git/files on the
// user's machine, the action persists a row here and waits via
// `runQuery` polling. The desktop client subscribes to pending rows
// for the active thread, executes via a narrow read-only IPC, and
// writes the result back via mutation.
//
// This separation is property X + Y from the design discussion: the
// system prompt + tool registry are server-defined (can't be tampered
// with by a modified client), and the model loop runs server-side.
// The client only executes specific read-only operations.

export const store_thread_tool_call_status_validator = v.union(
  v.literal("pending"),
  v.literal("complete"),
  v.literal("error"),
);

const storeThreadPendingToolCallFields = {
  ownerId: v.string(),
  threadRef: v.id("store_threads"),
  /** Desktop device that originated the Store agent turn. */
  targetDeviceId: v.string(),
  /** Stable id used by the action to wait on a specific call. */
  toolCallId: v.string(),
  toolName: v.string(),
  argsJson: v.string(),
  status: store_thread_tool_call_status_validator,
  resultText: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  createdAt: v.number(),
  completedAt: v.optional(v.number()),
};

export const store_thread_pending_tool_call_validator = v.object({
  _id: v.id("store_thread_pending_tool_calls"),
  _creationTime: v.number(),
  ...storeThreadPendingToolCallFields,
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

  store_threads: defineTable(storeThreadFields).index("by_ownerId", [
    "ownerId",
  ]),

  store_thread_messages: defineTable(storeThreadMessageFields).index(
    "by_threadRef_and_createdAt",
    ["threadRef", "createdAt"],
  ),

  store_thread_pending_tool_calls: defineTable(storeThreadPendingToolCallFields)
    .index("by_threadRef_and_status_and_createdAt", [
      "threadRef",
      "status",
      "createdAt",
    ])
    .index("by_threadRef_and_targetDeviceId_and_status_and_createdAt", [
      "threadRef",
      "targetDeviceId",
      "status",
      "createdAt",
    ])
    .index("by_toolCallId", ["toolCallId"]),
};
