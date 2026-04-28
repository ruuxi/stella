import { defineTable } from "convex/server";
import { v } from "convex/values";

export const store_release_manifest_validator = v.object({
  includedBatchIds: v.array(v.string()),
  includedCommitHashes: v.array(v.string()),
  changedFiles: v.array(v.string()),
  category: v.optional(v.union(v.literal("agents"), v.literal("stella"))),
  artifactHash: v.optional(v.string()),
  summary: v.optional(v.string()),
  iconUrl: v.optional(v.string()),
  authorDisplayName: v.optional(v.string()),
});

const storePackageFields = {
  ownerId: v.string(),
  packageId: v.string(),
  category: v.optional(v.union(v.literal("agents"), v.literal("stella"))),
  displayName: v.string(),
  description: v.string(),
  latestReleaseNumber: v.number(),
  latestReleaseId: v.optional(v.id("store_package_releases")),
  createdAt: v.number(),
  updatedAt: v.number(),
  authorDisplayName: v.optional(v.string()),
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

export const storeSchema = {
  store_packages: defineTable(storePackageFields)
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_packageId", ["ownerId", "packageId"])
    .index("by_packageId", ["packageId"])
    .index("by_featured_and_featuredAt", ["featured", "featuredAt"]),

  store_package_releases: defineTable(storePackageReleaseFields)
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_packageRef_and_releaseNumber", ["packageRef", "releaseNumber"])
    .index("by_packageId_and_releaseNumber", ["packageId", "releaseNumber"]),
};
