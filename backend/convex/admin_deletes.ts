import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { v } from "convex/values";
import { filterDisplayableTags } from "./lib/content_tags";

const BATCH = 100;

const deletedResult = v.object({
  deleted: v.boolean(),
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  hasMore: v.optional(v.boolean()),
});

const asId = <TableName extends TableNames>(id: string): Id<TableName> =>
  id as Id<TableName>;

const normalizeSlug = (value: string): string => value.trim().toLowerCase();

const getByStringId = async <TableName extends TableNames>(
  ctx: MutationCtx,
  id: string,
) => {
  try {
    return await ctx.db.get(asId<TableName>(id));
  } catch {
    return null;
  }
};

const applyEmojiFacetDelta = async (
  ctx: MutationCtx,
  tag: string,
  delta: number,
): Promise<void> => {
  const existing = await ctx.db
    .query("emoji_pack_tag_facets")
    .withIndex("by_tag", (q) => q.eq("tag", tag))
    .unique();
  if (!existing) {
    if (delta > 0) {
      await ctx.db.insert("emoji_pack_tag_facets", { tag, count: delta });
    }
    return;
  }
  const next = existing.count + delta;
  if (next <= 0) {
    await ctx.db.delete(existing._id);
  } else {
    await ctx.db.patch(existing._id, { count: next });
  }
};

export const deleteStorePackage = internalMutation({
  args: { packageId: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const packageId = normalizeSlug(args.packageId);
    const pkg = await ctx.db
      .query("store_packages")
      .withIndex("by_packageId", (q) => q.eq("packageId", packageId))
      .unique();
    if (!pkg) return { deleted: false, kind: "store_package", id: packageId };
    const releases = await ctx.db
      .query("store_package_releases")
      .withIndex("by_packageRef_and_releaseNumber", (q) =>
        q.eq("packageRef", pkg._id),
      )
      .take(1024);
    for (const release of releases) {
      await ctx.db.delete(release._id);
    }
    await ctx.db.delete(pkg._id);
    return {
      deleted: true,
      kind: "store_package",
      id: packageId,
      label: pkg.displayName,
    };
  },
});

export const deleteUserPet = internalMutation({
  args: { petId: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const petId = normalizeSlug(args.petId);
    const row = await ctx.db
      .query("user_pets")
      .withIndex("by_petId", (q) => q.eq("petId", petId))
      .unique();
    if (!row) return { deleted: false, kind: "user_pet", id: petId };
    await ctx.db.delete(row._id);
    return {
      deleted: true,
      kind: "user_pet",
      id: petId,
      label: row.displayName,
    };
  },
});

export const deleteEmojiPack = internalMutation({
  args: { packId: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const packId = normalizeSlug(args.packId);
    const row = await ctx.db
      .query("emoji_packs")
      .withIndex("by_packId", (q) => q.eq("packId", packId))
      .unique();
    if (!row) return { deleted: false, kind: "emoji_pack", id: packId };
    const memberships = await ctx.db
      .query("emoji_pack_tag_membership")
      .withIndex("by_packRef", (q) => q.eq("packRef", row._id))
      .take(BATCH);
    for (const membership of memberships) {
      await ctx.db.delete(membership._id);
    }
    if (row.visibility === "public") {
      for (const tag of new Set(filterDisplayableTags(row.tags))) {
        await applyEmojiFacetDelta(ctx, tag, -1);
      }
    }
    await ctx.db.delete(row._id);
    return {
      deleted: true,
      kind: "emoji_pack",
      id: packId,
      label: row.displayName,
    };
  },
});

export const deleteMediaJob = internalMutation({
  args: { jobId: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!job) return { deleted: false, kind: "media_job", id: args.jobId };
    const logs = await ctx.db
      .query("media_job_logs")
      .withIndex("by_jobId_and_ordinal", (q) => q.eq("jobId", args.jobId))
      .take(BATCH);
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    if (logs.length === BATCH) {
      return {
        deleted: false,
        kind: "media_job",
        id: args.jobId,
        hasMore: true,
      };
    }
    await ctx.db.delete(job._id);
    return { deleted: true, kind: "media_job", id: args.jobId };
  },
});

export const deleteFeedback = internalMutation({
  args: { id: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const id = asId<"user_feedback">(args.id);
    const row = await getByStringId<"user_feedback">(ctx, args.id);
    if (!row) return { deleted: false, kind: "feedback", id: args.id };
    await ctx.db.delete(id);
    return { deleted: true, kind: "feedback", id: args.id };
  },
});

export const deleteDesktopRelease = internalMutation({
  args: { platform: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const platform = args.platform.trim();
    const row = await ctx.db
      .query("desktop_releases")
      .withIndex("by_platform", (q) => q.eq("platform", platform))
      .unique();
    if (!row) {
      return { deleted: false, kind: "desktop_release", id: platform };
    }
    await ctx.db.delete(row._id);
    return {
      deleted: true,
      kind: "desktop_release",
      id: platform,
      label: row.tag,
    };
  },
});

export const deleteSocialMessage = internalMutation({
  args: { id: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const id = asId<"social_messages">(args.id);
    const row = await getByStringId<"social_messages">(ctx, args.id);
    if (!row) return { deleted: false, kind: "social_message", id: args.id };
    await ctx.db.delete(id);
    return { deleted: true, kind: "social_message", id: args.id };
  },
});

export const deleteStellaSessionBatch = internalMutation({
  args: { id: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const sessionId = asId<"stella_sessions">(args.id);
    const session = await getByStringId<"stella_sessions">(ctx, args.id);
    if (!session) {
      return { deleted: false, kind: "stella_session", id: args.id };
    }

    const fileOps = await ctx.db
      .query("stella_session_file_ops")
      .withIndex("by_sessionId_and_ordinal", (q) => q.eq("sessionId", sessionId))
      .take(BATCH);
    if (fileOps.length > 0) {
      for (const row of fileOps) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "stella_session",
        id: args.id,
        hasMore: true,
      };
    }

    const files = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_updatedAt", (q) => q.eq("sessionId", sessionId))
      .take(BATCH);
    if (files.length > 0) {
      for (const row of files) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "stella_session",
        id: args.id,
        hasMore: true,
      };
    }

    const blobs = await ctx.db
      .query("stella_session_file_blobs")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", sessionId))
      .take(BATCH);
    if (blobs.length > 0) {
      for (const row of blobs) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "stella_session",
        id: args.id,
        hasMore: true,
      };
    }

    const turns = await ctx.db
      .query("stella_session_turns")
      .withIndex("by_sessionId_and_ordinal", (q) => q.eq("sessionId", sessionId))
      .take(BATCH);
    if (turns.length > 0) {
      for (const row of turns) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "stella_session",
        id: args.id,
        hasMore: true,
      };
    }

    const members = await ctx.db
      .query("stella_session_members")
      .withIndex("by_sessionId_and_updatedAt", (q) => q.eq("sessionId", sessionId))
      .take(BATCH);
    if (members.length > 0) {
      for (const row of members) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "stella_session",
        id: args.id,
        hasMore: true,
      };
    }

    const room = await ctx.db.get(session.roomId);
    if (room?.stellaSessionId === sessionId) {
      await ctx.db.patch(room._id, { stellaSessionId: undefined });
    }
    await ctx.db.delete(sessionId);
    return { deleted: true, kind: "stella_session", id: args.id };
  },
});

export const deleteSocialRoomBatch = internalMutation({
  args: { id: v.string() },
  returns: deletedResult,
  handler: async (ctx, args) => {
    const roomId = asId<"social_rooms">(args.id);
    const room = await getByStringId<"social_rooms">(ctx, args.id);
    if (!room) return { deleted: false, kind: "social_room", id: args.id };

    const session = await ctx.db
      .query("stella_sessions")
      .withIndex("by_roomId", (q) => q.eq("roomId", roomId))
      .unique();
    if (session) {
      return {
        deleted: false,
        kind: "social_room",
        id: args.id,
        label: session._id,
        hasMore: true,
      };
    }

    const messages = await ctx.db
      .query("social_messages")
      .withIndex("by_roomId_and_createdAt", (q) => q.eq("roomId", roomId))
      .take(BATCH);
    if (messages.length > 0) {
      for (const row of messages) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "social_room",
        id: args.id,
        hasMore: true,
      };
    }

    const members = await ctx.db
      .query("social_room_members")
      .withIndex("by_roomId_and_joinedAt", (q) => q.eq("roomId", roomId))
      .take(BATCH);
    if (members.length > 0) {
      for (const row of members) await ctx.db.delete(row._id);
      return {
        deleted: false,
        kind: "social_room",
        id: args.id,
        hasMore: true,
      };
    }

    await ctx.db.delete(roomId);
    return {
      deleted: true,
      kind: "social_room",
      id: args.id,
      label: room.title,
    };
  },
});
