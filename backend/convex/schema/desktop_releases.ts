import { defineTable } from "convex/server";
import { v } from "convex/values";

// One row per platform identifier (e.g. "darwin-arm64", "darwin-x64",
// "win-x64"). The CI publish job upserts the latest published release
// here so installed desktops can subscribe via `useQuery` and receive a
// reactive push when a new version ships, without polling R2.
export const desktop_release_asset_validator = v.object({
  platform: v.string(),
  tag: v.string(),
  /** Upstream GitHub commit SHA the tarball was built from. */
  commit: v.string(),
  /** R2 download URL for the platform-specific tarball. */
  archiveUrl: v.string(),
  archiveSha256: v.string(),
  archiveSize: v.number(),
  publishedAt: v.number(),
});

const desktopReleaseFields = {
  platform: v.string(),
  tag: v.string(),
  commit: v.string(),
  archiveUrl: v.string(),
  archiveSha256: v.string(),
  archiveSize: v.number(),
  publishedAt: v.number(),
};

export const desktopReleasesSchema = {
  desktop_releases: defineTable(desktopReleaseFields).index("by_platform", [
    "platform",
  ]),
};
