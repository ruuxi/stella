import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { ConvexError, Infer, v } from "convex/values";
import {
  requireSensitiveUserIdAction,
  requireUserId,
} from "../auth";
import { requireBoundedString } from "../shared_validators";
import {
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
};

const create_first_release_args_validator = {
  ...create_release_args_validator,
  displayName: v.string(),
  description: v.string(),
};

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

const normalizeManifest = (
  manifest: {
    featureId: string;
    includedBatchIds: string[];
    includedCommitHashes: string[];
    changedFiles: string[];
    artifactHash?: string;
    summary?: string;
  },
) => {
  const featureId = normalizeRequiredText(manifest.featureId, "manifest.featureId", 120);
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

  return {
    featureId,
    includedBatchIds,
    includedCommitHashes,
    changedFiles,
    ...(artifactHash ? { artifactHash } : {}),
    ...(summary ? { summary } : {}),
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
    featureId: string;
    includedBatchIds: readonly string[];
    includedCommitHashes: readonly string[];
    changedFiles: readonly string[];
    artifactHash?: string;
    summary?: string;
  },
  right: {
    featureId: string;
    includedBatchIds: readonly string[];
    includedCommitHashes: readonly string[];
    changedFiles: readonly string[];
    artifactHash?: string;
    summary?: string;
  },
) =>
  left.featureId === right.featureId
  && left.artifactHash === right.artifactHash
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
    displayName: v.string(),
    description: v.string(),
    releaseNotes: v.optional(v.string()),
    manifest: store_release_manifest_validator,
    artifactStorageKey: v.id("_storage"),
    artifactUrl: v.union(v.null(), v.string()),
    artifactContentType: v.string(),
    artifactSize: v.number(),
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
    const packageRef = await ctx.db.insert("store_packages", {
      ownerId: args.ownerId,
      packageId: args.packageId,
      featureId: args.manifest.featureId,
      displayName: args.displayName,
      description: args.description,
      latestReleaseNumber: 0,
      createdAt: now,
      updatedAt: now,
    });

    const releaseRef = await ctx.db.insert("store_package_releases", {
      ownerId: args.ownerId,
      packageRef,
      packageId: args.packageId,
      featureId: args.manifest.featureId,
      releaseNumber: 1,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      artifactStorageKey: args.artifactStorageKey,
      artifactUrl: args.artifactUrl,
      artifactContentType: args.artifactContentType,
      artifactSize: args.artifactSize,
      createdAt: now,
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
  },
  handler: async (ctx, args) => {
    const pkg = await getOwnedPackageByPackageId(ctx, args.ownerId, args.packageId);
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Store package not found",
      });
    }

    if (pkg.featureId !== args.manifest.featureId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Release manifest feature does not match the existing package feature.",
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
      featureId: args.manifest.featureId,
      releaseNumber: nextReleaseNumber,
      releaseNotes: args.releaseNotes,
      manifest: args.manifest,
      artifactStorageKey: args.artifactStorageKey,
      artifactUrl: args.artifactUrl,
      artifactContentType: args.artifactContentType,
      artifactSize: args.artifactSize,
      createdAt: now,
    });

    await ctx.db.patch(pkg._id, {
      latestReleaseNumber: nextReleaseNumber,
      latestReleaseId: releaseRef,
      updatedAt: now,
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

    return await ctx.runMutation(internal.data.store_packages.createUpdateReleaseRecord, {
      ownerId,
      packageId,
      releaseNotes,
      manifest,
      artifactStorageKey,
      artifactUrl,
      artifactContentType,
      artifactSize: blob.size,
    });
  },
});
