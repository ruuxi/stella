import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";

/**
 * Latest published desktop release per platform.
 *
 * The CI publish job calls `publishDesktopRelease` (via an HTTP route
 * gated by a CI shared secret) once per platform after uploading the
 * tarball to R2. Installed desktops subscribe to
 * `currentDesktopRelease` via `useQuery` and react to a new commit
 * pointer the moment CI finishes — no polling required.
 */

const platformValidator = v.string();

export const currentDesktopRelease = query({
  args: {
    platform: platformValidator,
  },
  returns: v.union(
    v.null(),
    v.object({
      platform: v.string(),
      tag: v.string(),
      commit: v.string(),
      archiveUrl: v.string(),
      archiveSha256: v.string(),
      archiveSize: v.number(),
      publishedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", args.platform))
      .unique();
    if (!row) return null;
    return {
      platform: row.platform,
      tag: row.tag,
      commit: row.commit,
      archiveUrl: row.archiveUrl,
      archiveSha256: row.archiveSha256,
      archiveSize: row.archiveSize,
      publishedAt: row.publishedAt,
    };
  },
});

export const publishDesktopRelease = internalMutation({
  args: {
    platform: platformValidator,
    tag: v.string(),
    commit: v.string(),
    archiveUrl: v.string(),
    archiveSha256: v.string(),
    archiveSize: v.number(),
    publishedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", args.platform))
      .unique();
    const fields = {
      platform: args.platform,
      tag: args.tag,
      commit: args.commit,
      archiveUrl: args.archiveUrl,
      archiveSha256: args.archiveSha256,
      archiveSize: args.archiveSize,
      publishedAt: args.publishedAt,
    };
    if (existing) {
      await ctx.db.replace(existing._id, fields);
    } else {
      await ctx.db.insert("desktop_releases", fields);
    }
    return null;
  },
});
