import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { jsonValueValidator } from "../shared_validators";

const packageTypeValidator = v.union(
  v.literal("skill"),
  v.literal("canvas"),
  v.literal("plugin"),
  v.literal("theme"),
  v.literal("mod"),
);

const packageValidator = v.object({
  _id: v.id("store_packages"),
  _creationTime: v.number(),
  packageId: v.string(),
  name: v.string(),
  author: v.string(),
  description: v.string(),
  implementation: v.optional(v.string()),
  type: packageTypeValidator,
  version: v.string(),
  tags: v.array(v.string()),
  downloads: v.number(),
  rating: v.optional(v.number()),
  icon: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  readme: v.optional(v.string()),
  modPayload: v.optional(jsonValueValidator),
  searchText: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const buildSearchText = (
  name: string,
  description: string,
  tags: string[],
): string => `${name} ${description} ${tags.join(" ")}`;

const installValidator = v.object({
  _id: v.id("store_installs"),
  _creationTime: v.number(),
  ownerId: v.string(),
  packageId: v.string(),
  installedVersion: v.string(),
  installedAt: v.number(),
});

/**
 * List packages, optionally filtered by type.
 * Sorted by downloads descending, paginated (take 50).
 */
export const list = query({
  args: {
    type: v.optional(packageTypeValidator),
    cursor: v.optional(v.string()),
  },
  returns: v.array(packageValidator),
  handler: async (ctx, args) => {
    if (args.type) {
      const results = await ctx.db
        .query("store_packages")
        .withIndex("by_type", (q) => q.eq("type", args.type!))
        .order("desc")
        .take(50);
      // Sort by downloads descending
      return results.sort((a, b) => b.downloads - a.downloads);
    }
    const results = await ctx.db
      .query("store_packages")
      .withIndex("by_downloads")
      .order("desc")
      .take(50);
    return results;
  },
});

/**
 * Search packages by name using the search index.
 * Optionally filter by type.
 */
export const search = query({
  args: {
    query: v.string(),
    type: v.optional(packageTypeValidator),
  },
  returns: v.array(packageValidator),
  handler: async (ctx, args) => {
    if (!args.query.trim()) {
      return [];
    }
    const searchQ = ctx.db
      .query("store_packages")
      .withSearchIndex("search_packages", (q) => {
        const base = q.search("searchText", args.query);
        if (args.type) {
          return base.eq("type", args.type);
        }
        return base;
      });
    const results = await searchQ.take(50);
    return results;
  },
});

/**
 * Get a single package by its packageId.
 */
export const getByPackageId = query({
  args: {
    packageId: v.string(),
  },
  returns: v.union(packageValidator, v.null()),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("store_packages")
      .withIndex("by_package_id", (q) => q.eq("packageId", args.packageId))
      .first();
    return result;
  },
});

/**
 * Record a package installation for the current owner.
 * Increments the download count on the package.
 * Upserts into store_installs.
 */
export const install = mutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
    version: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Find the package
    const pkg = await ctx.db
      .query("store_packages")
      .withIndex("by_package_id", (q) => q.eq("packageId", args.packageId))
      .first();

    if (!pkg) {
      throw new Error(`Package not found: ${args.packageId}`);
    }

    // Increment downloads
    await ctx.db.patch(pkg._id, {
      downloads: pkg.downloads + 1,
      updatedAt: Date.now(),
    });

    // Upsert install record
    const existing = await ctx.db
      .query("store_installs")
      .withIndex("by_owner_package", (q) =>
        q.eq("ownerId", args.ownerId).eq("packageId", args.packageId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        installedVersion: args.version,
        installedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("store_installs", {
        ownerId: args.ownerId,
        packageId: args.packageId,
        installedVersion: args.version,
        installedAt: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Remove an installation record.
 */
export const uninstall = mutation({
  args: {
    ownerId: v.string(),
    packageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("store_installs")
      .withIndex("by_owner_package", (q) =>
        q.eq("ownerId", args.ownerId).eq("packageId", args.packageId),
      )
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    }

    return null;
  },
});

/**
 * Get all installed packages for an owner.
 */
export const getInstalled = query({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(installValidator),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("store_installs")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(200);
    return results;
  },
});

/**
 * Seed built-in packages (idempotent).
 */
export const seed = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const seedPackages: Array<{
      packageId: string;
      name: string;
      type: "skill" | "canvas" | "plugin" | "theme";
      author: string;
      description: string;
      tags: string[];
      version: string;
    }> = [];

    if (seedPackages.length === 0) {
      return null;
    }

    for (const pkg of seedPackages) {
      const existing = await ctx.db
        .query("store_packages")
        .withIndex("by_package_id", (q) => q.eq("packageId", pkg.packageId))
        .first();

      if (!existing) {
        const now = Date.now();
        await ctx.db.insert("store_packages", {
          ...pkg,
          downloads: 0,
          searchText: buildSearchText(pkg.name, pkg.description, pkg.tags),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return null;
  },
});

/**
 * Publish a self-mod feature as a mod package in the store.
 * Upserts by packageId so re-publishing updates the existing entry.
 */
export const publishMod = mutation({
  args: {
    packageId: v.string(),
    name: v.string(),
    author: v.string(),
    description: v.string(),
    implementation: v.optional(v.string()),
    version: v.string(),
    tags: v.array(v.string()),
    modPayload: jsonValueValidator,
  },
  returns: v.id("store_packages"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("store_packages")
      .withIndex("by_package_id", (q) => q.eq("packageId", args.packageId))
      .first();

    const now = Date.now();

    const searchText = buildSearchText(args.name, args.description, args.tags);

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        description: args.description,
        implementation: args.implementation,
        version: args.version,
        tags: args.tags,
        modPayload: args.modPayload,
        searchText,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("store_packages", {
      packageId: args.packageId,
      name: args.name,
      author: args.author,
      description: args.description,
      implementation: args.implementation,
      type: "mod",
      version: args.version,
      tags: args.tags,
      downloads: 0,
      modPayload: args.modPayload,
      searchText,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Backfill searchText for existing packages that don't have it yet.
 * Run once after deploying the schema change.
 */
export const backfillSearchText = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query("store_packages").collect();
    let updated = 0;
    for (const pkg of all) {
      if (!pkg.searchText) {
        await ctx.db.patch(pkg._id, {
          searchText: buildSearchText(pkg.name, pkg.description, pkg.tags),
        });
        updated++;
      }
    }
    return updated;
  },
});
