import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, Infer, v } from "convex/values";
import {
  requireSensitiveUserIdAction,
  requireUserId,
} from "../auth";
import { requireBoundedString } from "../shared_validators";
import {
  store_package_category_validator,
  store_package_release_validator,
  store_package_validator,
  store_publish_result_validator,
  store_release_manifest_validator,
} from "../schema/store";
import { enforceStoreReleaseReviewOrThrow } from "../lib/store_release_reviews";
import {
  enforceActionRateLimit,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import {
  normalizeStoreCategory,
} from "../lib/store_artifacts";

type StorePublishResult = Infer<typeof store_publish_result_validator>;

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_RELEASE_NOTES_LENGTH = 4000;
const MAX_MANIFEST_SUMMARY_LENGTH = 500;
const MAX_ARRAY_LENGTH = 512;
const MAX_PATH_LENGTH = 500;
const DEFAULT_ARTIFACT_CONTENT_TYPE = "application/json";

const create_release_args_validator = {
  packageId: v.string(),
  releaseNotes: v.optional(v.string()),
  manifest: store_release_manifest_validator,
  artifactBody: v.string(),
  artifactContentType: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  authorDisplayName: v.optional(v.string()),
  // `authorHandle` is intentionally NOT a public arg — the action
  // resolves it from `user_profiles` for the authenticated caller.
  // Trusting an arg here would let a modified renderer impersonate
  // another creator's handle in public discovery / `/c/:handle`.
};

const create_first_release_args_validator = {
  ...create_release_args_validator,
  category: v.optional(store_package_category_validator),
  displayName: v.string(),
  description: v.string(),
};

/**
 * Resolve the caller's claimed creator handle from `user_profiles`.
 * Used by every public release-creation path so the persisted
 * `authorHandle` always reflects the authenticated caller — never
 * a renderer-supplied value. Returns `undefined` when the user
 * hasn't claimed a handle yet (the side panel prompts on first
 * publish, but the action must still succeed without one).
 */
const resolveCallerAuthorHandle = async (
  ctx: { runQuery: (fn: typeof internal.data.user_profiles.getHandleForOwnerInternal, args: { ownerId: string }) => Promise<string | null> },
  ownerId: string,
): Promise<string | undefined> => {
  try {
    const handle = await ctx.runQuery(
      internal.data.user_profiles.getHandleForOwnerInternal,
      { ownerId },
    );
    return handle ? handle.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Denormalized lowercased text used as the searchField for the public
 * Discover search index. We join `displayName` and `description` so a
 * single substring search hits both. Refreshed on every release that
 * changes surface metadata; otherwise the row's previous text stays
 * authoritative.
 */
const buildPackageSearchText = (displayName: string, description: string): string =>
  `${displayName} ${description}`.toLowerCase();

const normalizePackageId = (value: string) => {
  const normalized = value.trim().toLowerCase();
  requireBoundedString(normalized, "packageId", 64);
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Package ID must use lowercase letters, numbers, hyphens, or underscores.",
    });
  }
  return normalized;
};

const normalizeRequiredText = (
  value: string,
  fieldName: string,
  maxLength: number,
) => {
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
) => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  requireBoundedString(normalized, fieldName, maxLength);
  return normalized;
};

const normalizeArtifactBody = (value: string) => {
  if (value.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "artifactBody is required",
    });
  }
  requireBoundedString(value, "artifactBody", 900_000);
  return value;
};

const normalizeReleaseNumber = (value: number) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "releaseNumber must be a positive integer",
    });
  }
  return value;
};

const normalizeStringArray = (
  values: readonly string[],
  fieldName: string,
  maxItems: number,
  maxItemLength: number,
) => {
  if (values.length > maxItems) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${fieldName} exceeds maximum allowed length of ${maxItems} items`,
    });
  }

  return values.map((value, index) => {
    const normalized = value.trim();
    if (!normalized) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `${fieldName}[${index}] is required`,
      });
    }
    requireBoundedString(normalized, `${fieldName}[${index}]`, maxItemLength);
    return normalized;
  });
};

type ParentRefInput = {
  authorHandle: string;
  packageId: string;
  compatibleWithReleaseNumber: number;
};

const MAX_PARENT_REFS = 8;

const normalizeParentRefs = (
  parents: ParentRefInput[] | undefined,
): ParentRefInput[] | undefined => {
  if (!parents || parents.length === 0) return undefined;
  if (parents.length > MAX_PARENT_REFS) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `manifest.parent exceeds maximum of ${MAX_PARENT_REFS} references`,
    });
  }
  const seen = new Set<string>();
  const out: ParentRefInput[] = [];
  for (const parent of parents) {
    const handle = normalizeRequiredText(parent.authorHandle, "manifest.parent[].authorHandle", 64);
    const packageId = normalizePackageId(parent.packageId);
    const releaseNumber = normalizeReleaseNumber(parent.compatibleWithReleaseNumber);
    const key = `${handle}/${packageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      authorHandle: handle,
      packageId,
      compatibleWithReleaseNumber: releaseNumber,
    });
  }
  return out.length > 0 ? out : undefined;
};

const normalizeAuthoredAgainst = (
  value: { stellaCommit?: string } | undefined,
):
  | { stellaCommit?: string }
  | undefined => {
  if (!value) return undefined;
  const stellaCommit = normalizeOptionalText(
    value.stellaCommit,
    "manifest.authoredAgainst.stellaCommit",
    80,
  );
  if (!stellaCommit) return undefined;
  return { stellaCommit };
};

type ManifestCategory =
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other";

const normalizeManifest = (
  manifest: {
    includedBatchIds: string[];
    includedCommitHashes: string[];
    changedFiles: string[];
    category?: ManifestCategory;
    artifactHash?: string;
    summary?: string;
    iconUrl?: string;
    authorDisplayName?: string;
    parent?: ParentRefInput[];
    authoredAgainst?: { stellaCommit?: string };
  },
) => {
  const includedBatchIds = normalizeStringArray(
    manifest.includedBatchIds,
    "manifest.includedBatchIds",
    MAX_ARRAY_LENGTH,
    120,
  );
  const includedCommitHashes = normalizeStringArray(
    manifest.includedCommitHashes,
    "manifest.includedCommitHashes",
    MAX_ARRAY_LENGTH,
    80,
  );
  const changedFiles = normalizeStringArray(
    manifest.changedFiles,
    "manifest.changedFiles",
    MAX_ARRAY_LENGTH,
    MAX_PATH_LENGTH,
  );
  const artifactHash = normalizeOptionalText(
    manifest.artifactHash,
    "manifest.artifactHash",
    256,
  );
  const summary = normalizeOptionalText(
    manifest.summary,
    "manifest.summary",
    MAX_MANIFEST_SUMMARY_LENGTH,
  );
  const iconUrl = normalizeOptionalText(manifest.iconUrl, "manifest.iconUrl", 2048);
  const authorDisplayName = normalizeOptionalText(
    manifest.authorDisplayName,
    "manifest.authorDisplayName",
    120,
  );
  const parent = normalizeParentRefs(manifest.parent);
  const authoredAgainst = normalizeAuthoredAgainst(manifest.authoredAgainst);

  return {
    includedBatchIds,
    includedCommitHashes,
    changedFiles,
    ...(manifest.category ? { category: normalizeStoreCategory(manifest.category) } : {}),
    ...(artifactHash ? { artifactHash } : {}),
    ...(summary ? { summary } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(authorDisplayName ? { authorDisplayName } : {}),
    ...(parent ? { parent } : {}),
    ...(authoredAgainst ? { authoredAgainst } : {}),
  };
};

const normalizeArtifactContentType = (value: string | undefined) => {
  const normalized = value?.trim() || DEFAULT_ARTIFACT_CONTENT_TYPE;
  requireBoundedString(normalized, "artifactContentType", 200);
  return normalized;
};

const areStringArraysEqual = (
  left: readonly string[],
  right: readonly string[],
) =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const areManifestMetadataEqual = (
  left: {
    includedBatchIds: readonly string[];
    includedCommitHashes: readonly string[];
    changedFiles: readonly string[];
    artifactHash?: string;
    summary?: string;
  },
  right: {
    includedBatchIds: readonly string[];
    includedCommitHashes: readonly string[];
    changedFiles: readonly string[];
    artifactHash?: string;
    summary?: string;
  },
) =>
  left.artifactHash === right.artifactHash
  && left.summary === right.summary
  && areStringArraysEqual(left.includedBatchIds, right.includedBatchIds)
  && areStringArraysEqual(left.includedCommitHashes, right.includedCommitHashes)
  && areStringArraysEqual(left.changedFiles, right.changedFiles);

const getOwnedPackageByPackageId = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  packageId: string,
) => {
  return await ctx.db
    .query("store_packages")
    .withIndex("by_ownerId_and_packageId", (q) =>
      q.eq("ownerId", ownerId).eq("packageId", packageId),
    )
    .unique();
};

const getPackageByPackageId = async (
  ctx: QueryCtx | MutationCtx,
  packageId: string,
) => {
  return await ctx.db
    .query("store_packages")
    .withIndex("by_packageId", (q) => q.eq("packageId", packageId))
    .unique();
};

const getReleaseByPackageIdAndNumber = async (
  ctx: QueryCtx | MutationCtx,
  packageId: string,
  releaseNumber: number,
) => {
  return await ctx.db
    .query("store_package_releases")
    .withIndex("by_packageId_and_releaseNumber", (q) =>
      q.eq("packageId", packageId).eq("releaseNumber", releaseNumber),
    )
    .unique();
};

export const listPackagesForOwnerInternal = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(200);
  },
});

export const getPackageByPackageIdInternal = internalQuery({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getOwnedPackageByPackageId(ctx, args.ownerId, normalizedPackageId);
  },
});

/**
 * Internal: cross-owner lookup by `packageId` alone. Used by the
 * Store thread when resolving `Stella-Parent-Package-Id` trailers
 * that point at add-ons published by other creators (the publishing
 * user wouldn't necessarily have an owned row for them).
 */
export const getAnyPackageByPackageIdInternal = internalQuery({
  args: { packageId: v.string() },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getPackageByPackageId(ctx, normalizedPackageId);
  },
});

export const listReleasesForPackageInternal = internalQuery({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(ctx, args.ownerId, normalizedPackageId);
    if (!pkg) {
      return [];
    }

    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
  },
});

export const getReleaseByPackageIdAndNumberInternal = internalQuery({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(ctx, args.ownerId, normalizedPackageId);
    if (!pkg) {
      return null;
    }
    return await getReleaseByPackageIdAndNumber(
      ctx,
      normalizedPackageId,
      normalizeReleaseNumber(args.releaseNumber),
    );
  },
});

export const createFirstReleaseRecord = internalMutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    category: v.optional(store_package_category_validator),
    displayName: v.string(),
    description: v.string(),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    artifactStorageKey: v.id("_storage"),
    artifactUrl: v.union(v.null(), v.string()),
    artifactContentType: v.string(),
    artifactSize: v.number(),
    iconUrl: v.optional(v.string()),
    authorDisplayName: v.optional(v.string()),
    authorHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await getPackageByPackageId(ctx, args.packageId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That package ID is already in use.",
      });
    }

    const now = Date.now();
    const category = normalizeStoreCategory(args.category ?? args.manifest.category);
    const packageRef = await ctx.db.insert("store_packages", {
      ownerId: args.ownerId,
      packageId: args.packageId,
      category,
      displayName: args.displayName,
      description: args.description,
      searchText: buildPackageSearchText(args.displayName, args.description),
      latestReleaseNumber: 0,
      createdAt: now,
      updatedAt: now,
      ...(args.iconUrl ? { iconUrl: args.iconUrl } : {}),
      ...(args.authorDisplayName
        ? { authorDisplayName: args.authorDisplayName }
        : {}),
      ...(args.authorHandle ? { authorHandle: args.authorHandle } : {}),
    });

    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef,
      packageId: args.packageId,
      releaseNumber: 1,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      artifactStorageKey: args.artifactStorageKey,
      artifactUrl: args.artifactUrl,
      artifactContentType: args.artifactContentType,
      artifactSize: args.artifactSize,
      createdAt: now,
      ...(args.manifest.parent && args.manifest.parent.length > 0
        ? { parent: args.manifest.parent }
        : {}),
      ...(args.manifest.authoredAgainst
        ? { authoredAgainst: args.manifest.authoredAgainst }
        : {}),
    });

    await ctx.db.patch(packageRef, {
      latestReleaseNumber: 1,
      latestReleaseId: releaseRef,
      updatedAt: now,
    });

    const pkg = await ctx.db.get(packageRef);
    const release = await ctx.db.get(releaseRef);
    if (!pkg || !release) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to load created store package release records",
      });
    }

    return {
      package: pkg,
      release,
    };
  },
});

export const createUpdateReleaseRecord = internalMutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    artifactStorageKey: v.id("_storage"),
    artifactUrl: v.union(v.null(), v.string()),
    artifactContentType: v.string(),
    artifactSize: v.number(),
    iconUrl: v.optional(v.string()),
    authorDisplayName: v.optional(v.string()),
    authorHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pkg = await getOwnedPackageByPackageId(ctx, args.ownerId, args.packageId);
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Store package not found",
      });
    }

    const latestRelease = pkg.latestReleaseNumber > 0
      ? await getReleaseByPackageIdAndNumber(ctx, args.packageId, pkg.latestReleaseNumber)
      : null;
    if (
      latestRelease
      && latestRelease.releaseNotes === args.releaseNotes
      && areManifestMetadataEqual(latestRelease.manifest, args.manifest)
    ) {
      return {
        package: pkg,
        release: latestRelease,
      };
    }

    const nextReleaseNumber = pkg.latestReleaseNumber + 1;
    const now = Date.now();
    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef: pkg._id,
      packageId: args.packageId,
      releaseNumber: nextReleaseNumber,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      artifactStorageKey: args.artifactStorageKey,
      artifactUrl: args.artifactUrl,
      artifactContentType: args.artifactContentType,
      artifactSize: args.artifactSize,
      createdAt: now,
      ...(args.manifest.parent && args.manifest.parent.length > 0
        ? { parent: args.manifest.parent }
        : {}),
      ...(args.manifest.authoredAgainst
        ? { authoredAgainst: args.manifest.authoredAgainst }
        : {}),
    });

    // Refresh the package row's surface metadata to whatever this release
    // provides. Icons and author names are intentionally allowed to change
    // across releases (e.g. a re-themed mod gets a new icon next time).
    await ctx.db.patch(pkg._id, {
      latestReleaseNumber: nextReleaseNumber,
      latestReleaseId: releaseRef,
      updatedAt: now,
      ...(args.iconUrl ? { iconUrl: args.iconUrl } : {}),
      ...(args.authorDisplayName
        ? { authorDisplayName: args.authorDisplayName }
        : {}),
      ...(args.authorHandle ? { authorHandle: args.authorHandle } : {}),
    });

    const updatedPackage = await ctx.db.get(pkg._id);
    const release = await ctx.db.get(releaseRef);
    if (!updatedPackage || !release) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to load updated store package release records",
      });
    }

    return {
      package: updatedPackage,
      release,
    };
  },
});

export const listPackages = query({
  args: {},
  returns: v.array(store_package_validator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

const PUBLIC_BROWSE_PAGE_SIZE = 40;
const PUBLIC_SEARCH_MAX_RESULTS = 60;

export const listPublicPackages = query({
  args: {
    category: v.optional(store_package_category_validator),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(store_package_validator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    // Cap `numItems` server-side so a misbehaving client can't ask for
    // huge pages, but otherwise honour Convex's standard pagination
    // shape so `usePaginatedQuery` can walk every page from the
    // renderer.
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      PUBLIC_BROWSE_PAGE_SIZE,
    );
    const indexed = args.category
      ? ctx.db
          .query("store_packages")
          .withIndex("by_category_and_updatedAt", (q) =>
            q.eq("category", args.category!),
          )
      : ctx.db.query("store_packages").withIndex("by_updatedAt");
    return await indexed.order("desc").paginate({
      cursor: args.paginationOpts.cursor,
      numItems,
    });
  },
});

export const getPublicPackage = query({
  args: { packageId: v.string() },
  returns: v.union(store_package_validator, v.null()),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getPackageByPackageId(ctx, normalizedPackageId);
  },
});

export const getPublicPackagesByIds = query({
  args: { packageIds: v.array(v.string()) },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    if (args.packageIds.length === 0) return [];
    // Cap to keep this cheap (the side panel only ever asks for the
    // user's installed-but-not-owned set, which is realistically small).
    const uniqueIds = Array.from(
      new Set(args.packageIds.map((id) => normalizePackageId(id))),
    ).slice(0, 200);
    const records = await Promise.all(
      uniqueIds.map((id) => getPackageByPackageId(ctx, id)),
    );
    return records.filter(
      (record): record is NonNullable<typeof record> => record !== null,
    );
  },
});

export const listPublicReleases = query({
  args: { packageId: v.string() },
  returns: v.array(store_package_release_validator),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return [];
    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
  },
});

export const getPublicRelease = query({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  returns: v.union(store_package_release_validator, v.null()),
  handler: async (ctx, args) => {
    const normalizedPackageId = normalizePackageId(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const pkg = await getPackageByPackageId(ctx, normalizedPackageId);
    if (!pkg) return null;
    return await getReleaseByPackageIdAndNumber(ctx, normalizedPackageId, releaseNumber);
  },
});

export const searchPublicPackages = query({
  args: {
    query: v.string(),
    category: v.optional(store_package_category_validator),
  },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const needle = args.query.trim().toLowerCase();
    if (!needle) return [];
    return await ctx.db
      .query("store_packages")
      .withSearchIndex("search_text", (q) => {
        const base = q.search("searchText", needle);
        return args.category ? base.eq("category", args.category) : base;
      })
      .take(PUBLIC_SEARCH_MAX_RESULTS);
  },
});

export const listPackagesByAuthorHandle = query({
  args: { handle: v.string() },
  returns: v.array(store_package_validator),
  handler: async (ctx, args) => {
    const handle = args.handle.trim().toLowerCase();
    if (!handle) return [];
    // Resolve handle -> ownerId via `user_profiles`, then list owned
    // packages. Two reads; both indexed.
    const profile = await ctx.db
      .query("user_profiles")
      .withIndex("by_publicHandle", (q) => q.eq("publicHandle", handle))
      .unique();
    if (!profile) return [];
    return await ctx.db
      .query("store_packages")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", profile.ownerId),
      )
      .order("desc")
      .take(200);
  },
});

export const getPackage = query({
  args: {
    packageId: v.string(),
  },
  returns: v.union(store_package_validator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalizedPackageId = normalizePackageId(args.packageId);
    return await getOwnedPackageByPackageId(ctx, ownerId, normalizedPackageId);
  },
});

export const listReleases = query({
  args: {
    packageId: v.string(),
  },
  returns: v.array(store_package_release_validator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalizedPackageId = normalizePackageId(args.packageId);
    const pkg = await getOwnedPackageByPackageId(ctx, ownerId, normalizedPackageId);
    if (!pkg) {
      return [];
    }

    return await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageId_and_releaseNumber", (q) =>
        q.eq("packageId", normalizedPackageId),
      )
      .order("desc")
      .take(200);
  },
});

export const getRelease = query({
  args: {
    packageId: v.string(),
    releaseNumber: v.number(),
  },
  returns: v.union(store_package_release_validator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalizedPackageId = normalizePackageId(args.packageId);
    const releaseNumber = normalizeReleaseNumber(args.releaseNumber);
    const pkg = await getOwnedPackageByPackageId(ctx, ownerId, normalizedPackageId);
    if (!pkg) {
      return null;
    }
    return await getReleaseByPackageIdAndNumber(ctx, normalizedPackageId, releaseNumber);
  },
});

export const createFirstRelease = action({
  args: create_first_release_args_validator,
  returns: store_publish_result_validator,
  handler: async (ctx, args): Promise<StorePublishResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    // Each release writes an artifact blob to _storage and runs an LLM
    // review action. Tight cap so a runaway client can't fill storage.
    await enforceActionRateLimit(
      ctx,
      "store_package_create_first_release",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many store package releases. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const category = normalizeStoreCategory(args.category ?? args.manifest.category);
    const displayName = normalizeRequiredText(args.displayName, "displayName", 120);
    const description = normalizeRequiredText(args.description, "description", 4000);
    const releaseNotes = normalizeOptionalText(
      args.releaseNotes,
      "releaseNotes",
      MAX_RELEASE_NOTES_LENGTH,
    );
    const manifest = normalizeManifest(args.manifest);
    const artifactBody = normalizeArtifactBody(args.artifactBody);
    const artifactContentType = normalizeArtifactContentType(args.artifactContentType);
    await enforceStoreReleaseReviewOrThrow(ctx, {
      ownerId,
      packageId,
      displayName,
      description,
      releaseSummary: releaseNotes,
      artifactBody,
    });

    const blob = new Blob([artifactBody], {
      type: artifactContentType,
    });
    const artifactStorageKey = await ctx.storage.store(blob);
    const artifactUrl = await ctx.storage.getUrl(artifactStorageKey);

    // Resolve `authorHandle` server-side from `user_profiles`. This
    // action is reachable from the renderer, so trusting an
    // `args.authorHandle` would let a modified client publish a row
    // that links to another creator's handle. Public discovery + the
    // `/c/:handle` page treat this field as identity, so it must
    // reflect the *caller's* claimed handle (or be empty).
    const authorHandle = await resolveCallerAuthorHandle(ctx, ownerId);
    return await ctx.runMutation(internal.data.store_packages.createFirstReleaseRecord, {
      ownerId,
      packageId,
      displayName,
      description,
      releaseNotes,
      manifest,
      artifactStorageKey,
      artifactUrl,
      artifactContentType,
      artifactSize: blob.size,
      ...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
      ...(manifest.authorDisplayName
        ? { authorDisplayName: manifest.authorDisplayName }
        : {}),
      ...(authorHandle ? { authorHandle } : {}),
    });
  },
});

export const createUpdateRelease = action({
  args: create_release_args_validator,
  returns: store_publish_result_validator,
  handler: async (ctx, args): Promise<StorePublishResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    await enforceActionRateLimit(
      ctx,
      "store_package_create_update_release",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many store package releases. Please wait before publishing again.",
    );
    const packageId = normalizePackageId(args.packageId);
    const releaseNotes = normalizeOptionalText(
      args.releaseNotes,
      "releaseNotes",
      MAX_RELEASE_NOTES_LENGTH,
    );
    const manifest = normalizeManifest(args.manifest);
    const artifactBody = normalizeArtifactBody(args.artifactBody);
    const artifactContentType = normalizeArtifactContentType(args.artifactContentType);
    const pkg: Awaited<ReturnType<typeof getOwnedPackageByPackageId>> = await ctx.runQuery(
      internal.data.store_packages.getPackageByPackageIdInternal,
      { ownerId, packageId },
    );
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Store package not found",
      });
    }
    await enforceStoreReleaseReviewOrThrow(ctx, {
      ownerId,
      packageId,
      displayName: pkg.displayName,
      description: pkg.description,
      releaseSummary: releaseNotes,
      artifactBody,
    });

    const blob = new Blob([artifactBody], {
      type: artifactContentType,
    });
    const artifactStorageKey = await ctx.storage.store(blob);
    const artifactUrl = await ctx.storage.getUrl(artifactStorageKey);

    // See createFirstRelease — resolve handle server-side rather than
    // trusting the renderer-supplied `args.authorHandle`.
    const authorHandle = await resolveCallerAuthorHandle(ctx, ownerId);
    return await ctx.runMutation(internal.data.store_packages.createUpdateReleaseRecord, {
      ownerId,
      packageId,
      releaseNotes,
      manifest,
      artifactStorageKey,
      artifactUrl,
      artifactContentType,
      artifactSize: blob.size,
      ...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
      ...(manifest.authorDisplayName
        ? { authorDisplayName: manifest.authorDisplayName }
        : {}),
      ...(authorHandle ? { authorHandle } : {}),
    });
  },
});
