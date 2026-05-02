import { defineTable } from "convex/server";
import { v } from "convex/values";

export const socialRelationshipStatusValidator = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("blocked"),
);

export const socialRoomKindValidator = v.union(
  v.literal("dm"),
  v.literal("group"),
  v.literal("global"),
);

export const socialRoomMemberRoleValidator = v.union(
  v.literal("owner"),
  v.literal("member"),
);

export const socialMessageKindValidator = v.union(
  v.literal("text"),
  v.literal("system"),
);

export const socialMessageModerationStatusValidator = v.union(
  v.literal("pending"),
  v.literal("clean"),
  v.literal("censored"),
  v.literal("failed"),
);

export const stellaSessionStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("ended"),
);

export const stellaSessionTurnStatusValidator = v.union(
  v.literal("queued"),
  v.literal("claimed"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const stellaSessionFileOpTypeValidator = v.union(
  v.literal("upsert"),
  v.literal("delete"),
  v.literal("mkdir"),
);

export const socialSchema = {
  social_profiles: defineTable({
    ownerId: v.string(),
    nickname: v.string(),
    nicknameNormalized: v.string(),
    publicHandle: v.string(),
    friendCode: v.string(),
    avatarUrl: v.optional(v.string()),
    lastSeenIncomingFriendRequestAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_publicHandle", ["publicHandle"])
    .index("by_friendCode", ["friendCode"])
    .index("by_nicknameNormalized", ["nicknameNormalized"]),

  social_relationships: defineTable({
    relationshipKey: v.string(),
    lowOwnerId: v.string(),
    highOwnerId: v.string(),
    requesterOwnerId: v.string(),
    addresseeOwnerId: v.string(),
    initiatedByOwnerId: v.string(),
    status: socialRelationshipStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    respondedAt: v.optional(v.number()),
  })
    .index("by_relationshipKey", ["relationshipKey"])
    .index("by_lowOwnerId_and_status", ["lowOwnerId", "status"])
    .index("by_highOwnerId_and_status", ["highOwnerId", "status"])
    .index("by_requesterOwnerId_and_status", ["requesterOwnerId", "status"])
    .index("by_addresseeOwnerId_and_status", ["addresseeOwnerId", "status"]),

  social_rooms: defineTable({
    kind: socialRoomKindValidator,
    roomKey: v.optional(v.string()),
    title: v.optional(v.string()),
    createdByOwnerId: v.string(),
    stellaSessionId: v.optional(v.id("stella_sessions")),
    createdAt: v.number(),
    updatedAt: v.number(),
    latestMessageAt: v.optional(v.number()),
  })
    .index("by_roomKey", ["roomKey"])
    .index("by_createdByOwnerId_and_updatedAt", ["createdByOwnerId", "updatedAt"])
    .index("by_stellaSessionId", ["stellaSessionId"]),

  social_room_members: defineTable({
    roomId: v.id("social_rooms"),
    ownerId: v.string(),
    role: socialRoomMemberRoleValidator,
    joinedAt: v.number(),
    lastReadMessageId: v.optional(v.id("social_messages")),
    lastReadAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_roomId_and_ownerId", ["roomId", "ownerId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_roomId_and_joinedAt", ["roomId", "joinedAt"]),

  social_messages: defineTable({
    roomId: v.id("social_rooms"),
    senderOwnerId: v.string(),
    clientMessageId: v.optional(v.string()),
    kind: socialMessageKindValidator,
    body: v.string(),
    originalBody: v.optional(v.string()),
    moderationStatus: v.optional(socialMessageModerationStatusValidator),
    moderatedAt: v.optional(v.number()),
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
  })
    .index("by_roomId_and_createdAt", ["roomId", "createdAt"])
    .index("by_roomId_and_clientMessageId", ["roomId", "clientMessageId"])
    .index("by_senderOwnerId_and_createdAt", ["senderOwnerId", "createdAt"])
    .index("by_moderationStatus_and_createdAt", [
      "moderationStatus",
      "createdAt",
    ]),

  stella_sessions: defineTable({
    roomId: v.id("social_rooms"),
    hostOwnerId: v.string(),
    hostDeviceId: v.string(),
    createdByOwnerId: v.string(),
    workspaceSlug: v.string(),
    workspaceFolderName: v.string(),
    conversationId: v.string(),
    status: stellaSessionStatusValidator,
    latestTurnOrdinal: v.number(),
    latestFileOpOrdinal: v.number(),
    lastSnapshotAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_roomId", ["roomId"])
    .index("by_hostOwnerId_and_status", ["hostOwnerId", "status"])
    // Lets `listPendingTurnsForHostDevice` look sessions up by the exact
    // host owner + device + status without a JS-side `.filter` over a
    // collected result set.
    .index("by_hostOwnerId_and_hostDeviceId_and_status", [
      "hostOwnerId",
      "hostDeviceId",
      "status",
    ])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),

  stella_session_members: defineTable({
    sessionId: v.id("stella_sessions"),
    ownerId: v.string(),
    joinedAt: v.number(),
    lastAppliedFileOpOrdinal: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_sessionId_and_ownerId", ["sessionId", "ownerId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_sessionId_and_updatedAt", ["sessionId", "updatedAt"]),

  stella_session_turns: defineTable({
    sessionId: v.id("stella_sessions"),
    ordinal: v.number(),
    status: stellaSessionTurnStatusValidator,
    requestedByOwnerId: v.string(),
    requestId: v.optional(v.string()),
    prompt: v.string(),
    agentType: v.optional(v.string()),
    claimedByDeviceId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    resultText: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sessionId_and_ordinal", ["sessionId", "ordinal"])
    .index("by_sessionId_and_status_and_createdAt", ["sessionId", "status", "createdAt"])
    .index("by_requestId", ["requestId"]),

  stella_session_file_blobs: defineTable({
    sessionId: v.id("stella_sessions"),
    contentHash: v.string(),
    storageId: v.id("_storage"),
    sizeBytes: v.number(),
    contentType: v.string(),
    createdAt: v.number(),
  })
    .index("by_sessionId_and_contentHash", ["sessionId", "contentHash"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"]),

  stella_session_files: defineTable({
    sessionId: v.id("stella_sessions"),
    relativePath: v.string(),
    contentHash: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    deleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_sessionId_and_relativePath", ["sessionId", "relativePath"])
    .index("by_sessionId_and_updatedAt", ["sessionId", "updatedAt"])
    // Lets `listWorkspaceFiles` page over only live (non-tombstoned) files
    // ordered by path, so a session with many soft-deleted entries doesn't
    // cause us to read every row just to filter most of them out.
    .index("by_sessionId_and_deleted_and_relativePath", [
      "sessionId",
      "deleted",
      "relativePath",
    ]),

  stella_session_file_ops: defineTable({
    sessionId: v.id("stella_sessions"),
    ordinal: v.number(),
    type: stellaSessionFileOpTypeValidator,
    relativePath: v.string(),
    actorOwnerId: v.string(),
    contentHash: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_sessionId_and_ordinal", ["sessionId", "ordinal"])
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"]),
};
