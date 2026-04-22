import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  socialRoomValidator,
  stellaSessionMemberValidator,
  stellaSessionTurnValidator,
  stellaSessionValidator,
  stellaSessionFileOpValidator,
  requireConnectedSocialUserIdAction,
  requireRoomMembership,
  requireSessionHost,
  requireSessionMembership,
  sanitizeWorkspaceSlug,
  sanitizeWorkspaceFolderName,
  normalizeRelativeSessionPath,
  getSocialSessionConversationId,
} from "./shared";
import { requireConnectedUserId } from "../auth";
import { requireBoundedString } from "../shared_validators";

const MAX_WORKSPACE_SLUG_LENGTH = 48;
const MAX_WORKSPACE_FOLDER_NAME_LENGTH = 80;
const MAX_TURN_LIMIT = 200;
const MAX_FILE_OP_LIMIT = 500;
const MAX_FILE_BYTES = 700_000;
const MAX_SESSIONS_PER_ROOM_COLLECT = 100;
const MAX_ROOM_MEMBERS_COLLECT = 500;
const MAX_SESSION_TURNS_COLLECT = 500;
const MAX_SESSION_FILES_COLLECT = 5_000;
const MAX_BASE64_LENGTH = 950_000;
const MAX_SESSION_TURN_PROMPT_LENGTH = 20_000;
const MAX_SESSION_RESULT_LENGTH = 100_000;
const MAX_FILE_CONTENT_TYPE_LENGTH = 200;
const MAX_CONTENT_HASH_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 200;

const optionalSessionValidator = v.union(v.null(), stellaSessionValidator);

const roomSummaryValidator = v.object({
  room: socialRoomValidator,
  session: stellaSessionValidator,
  membershipRole: v.union(v.literal("owner"), v.literal("member")),
  isHost: v.boolean(),
});

const hostTurnSummaryValidator = v.object({
  session: stellaSessionValidator,
  room: socialRoomValidator,
  turn: stellaSessionTurnValidator,
});

const sessionFileSummaryValidator = v.object({
  relativePath: v.string(),
  kind: v.union(v.literal("file"), v.literal("directory")),
  contentHash: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
  contentType: v.optional(v.string()),
  updatedAt: v.number(),
  downloadUrl: v.optional(v.string()),
});

const sessionFileOpSummaryValidator = v.object({
  op: stellaSessionFileOpValidator,
  downloadUrl: v.optional(v.string()),
});

const parseBase64Bytes = (value: string): Buffer => {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Invalid base64 file content.",
    });
  }
};

const getSessionDoc = async (
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"stella_sessions">,
) => {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Session not found.",
    });
  }
  return session;
};

const getRoomDoc = async (
  ctx: QueryCtx | MutationCtx,
  roomId: Id<"social_rooms">,
) => {
  const room = await ctx.db.get(roomId);
  if (!room) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Room not found.",
    });
  }
  return room;
};

const ensureActiveSessionForMember = async (
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"stella_sessions">,
  ownerId: string,
) => {
  await requireSessionMembership(ctx, sessionId, ownerId);
  const session = await getSessionDoc(ctx, sessionId);
  if (session.status === "ended") {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Session is no longer active.",
    });
  }
  return session;
};

const ensureSessionAcceptsTurns = (session: Doc<"stella_sessions">) => {
  if (session.status !== "active") {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Session is not accepting new turns.",
    });
  }
};

const nextRoomTimestamp = () => Date.now();

const appendSessionSystemMessage = async (
  ctx: MutationCtx,
  args: {
    roomId: Id<"social_rooms">;
    senderOwnerId: string;
    body: string;
  },
) => {
  const timestamp = nextRoomTimestamp();
  await ctx.db.insert("social_messages", {
    roomId: args.roomId,
    senderOwnerId: args.senderOwnerId,
    kind: "system",
    body: args.body,
    createdAt: timestamp,
  });
  await ctx.db.patch(args.roomId, {
    updatedAt: timestamp,
    latestMessageAt: timestamp,
  });
};

const resolveActiveRoomSession = async (
  ctx: QueryCtx | MutationCtx,
  roomId: Id<"social_rooms">,
) => {
  const sessions = await ctx.db
    .query("stella_sessions")
    .withIndex("by_roomId", (q) => q.eq("roomId", roomId))
    .take(MAX_SESSIONS_PER_ROOM_COLLECT);
  return sessions.find((session) => session.status !== "ended") ?? null;
};

const createSessionMembers = async (
  ctx: MutationCtx,
  sessionId: Id<"stella_sessions">,
  roomId: Id<"social_rooms">,
) => {
  const roomMembers = await ctx.db
    .query("social_room_members")
    .withIndex("by_roomId_and_joinedAt", (q) => q.eq("roomId", roomId))
    .take(MAX_ROOM_MEMBERS_COLLECT);
  const timestamp = Date.now();
  await Promise.all(
    roomMembers.map((member) =>
      ctx.db.insert("stella_session_members", {
        sessionId,
        ownerId: member.ownerId,
        joinedAt: member.joinedAt,
        lastAppliedFileOpOrdinal: 0,
        updatedAt: timestamp,
      }),
    ),
  );
};

const createSessionSummary = async (
  ctx: QueryCtx,
  session: Doc<"stella_sessions">,
  ownerId: string,
) => {
  const room = await getRoomDoc(ctx, session.roomId);
  await requireSessionMembership(ctx, session._id, ownerId);
  const roomMembership = await requireRoomMembership(ctx, room._id, ownerId);
  return {
    room,
    session,
    membershipRole: roomMembership.role,
    isHost: session.hostOwnerId === ownerId && session.hostDeviceId.length > 0,
  };
};

export const getSessionInternal = internalQuery({
  args: { sessionId: v.id("stella_sessions") },
  returns: optionalSessionValidator,
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const getFileBlobByHashInternal = internalQuery({
  args: {
    sessionId: v.id("stella_sessions"),
    contentHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.id("_storage"),
      sizeBytes: v.number(),
      contentType: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stella_session_file_blobs")
      .withIndex("by_sessionId_and_contentHash", (q) =>
        q.eq("sessionId", args.sessionId).eq("contentHash", args.contentHash),
      )
      .unique();
    if (!existing) {
      return null;
    }
    return {
      storageId: existing.storageId,
      sizeBytes: existing.sizeBytes,
      contentType: existing.contentType,
    };
  },
});

export const recordFileUploadInternal = internalMutation({
  args: {
    sessionId: v.id("stella_sessions"),
    ownerId: v.string(),
    relativePath: v.string(),
    contentHash: v.string(),
    storageId: v.id("_storage"),
    sizeBytes: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    ordinal: v.number(),
    noop: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const session = await requireSessionHost(ctx, args.sessionId, args.ownerId);
    if (session.status === "ended") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Session is no longer active.",
      });
    }

    const existingBlob = await ctx.db
      .query("stella_session_file_blobs")
      .withIndex("by_sessionId_and_contentHash", (q) =>
        q.eq("sessionId", args.sessionId).eq("contentHash", args.contentHash),
      )
      .unique();
    if (!existingBlob) {
      await ctx.db.insert("stella_session_file_blobs", {
        sessionId: args.sessionId,
        contentHash: args.contentHash,
        storageId: args.storageId,
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        createdAt: Date.now(),
      });
    }

    const currentEntry = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_relativePath", (q) =>
        q.eq("sessionId", args.sessionId).eq("relativePath", args.relativePath),
      )
      .unique();

    if (
      currentEntry
      && currentEntry.deleted === false
      && currentEntry.contentHash === args.contentHash
      && currentEntry.sizeBytes === args.sizeBytes
      && currentEntry.contentType === args.contentType
    ) {
      return {
        ordinal: session.latestFileOpOrdinal,
        noop: true,
      };
    }

    const nextOrdinal = session.latestFileOpOrdinal + 1;
    const timestamp = Date.now();
    if (currentEntry) {
      await ctx.db.patch(currentEntry._id, {
        contentHash: args.contentHash,
        storageId: args.storageId,
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        deleted: false,
        updatedAt: timestamp,
      });
    } else {
      await ctx.db.insert("stella_session_files", {
        sessionId: args.sessionId,
        relativePath: args.relativePath,
        contentHash: args.contentHash,
        storageId: args.storageId,
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        deleted: false,
        updatedAt: timestamp,
      });
    }

    await ctx.db.insert("stella_session_file_ops", {
      sessionId: args.sessionId,
      ordinal: nextOrdinal,
      type: "upsert",
      relativePath: args.relativePath,
      actorOwnerId: args.ownerId,
      contentHash: args.contentHash,
      storageId: args.storageId,
      sizeBytes: args.sizeBytes,
      contentType: args.contentType,
      createdAt: timestamp,
    });

    await ctx.db.patch(session._id, {
      latestFileOpOrdinal: nextOrdinal,
      updatedAt: timestamp,
    });

    return {
      ordinal: nextOrdinal,
      noop: false,
    };
  },
});

export const listSessions = query({
  args: {},
  returns: v.array(roomSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx);
    const memberships = await ctx.db
      .query("stella_session_members")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(100);
    const summaries = await Promise.all(
      memberships.map(async (membership) => {
        const session = await ctx.db.get(membership.sessionId);
        if (!session) {
          return null;
        }
        return await createSessionSummary(ctx, session, ownerId);
      }),
    );
    return summaries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  },
});

export const getSession = query({
  args: {
    sessionId: v.id("stella_sessions"),
  },
  returns: v.union(v.null(), roomSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const membership = await ctx.db
      .query("stella_session_members")
      .withIndex("by_sessionId_and_ownerId", (q) =>
        q.eq("sessionId", args.sessionId).eq("ownerId", ownerId),
      )
      .unique();
    if (!membership) {
      return null;
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return null;
    }
    return await createSessionSummary(ctx, session, ownerId);
  },
});

export const createSession = mutation({
  args: {
    roomId: v.id("social_rooms"),
    hostDeviceId: v.string(),
    workspaceSlug: v.string(),
    workspaceFolderName: v.optional(v.string()),
  },
  returns: stellaSessionValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await requireRoomMembership(ctx, args.roomId, ownerId);
    const room = await getRoomDoc(ctx, args.roomId);

    const existing = room.stellaSessionId
      ? await ctx.db.get(room.stellaSessionId)
      : await resolveActiveRoomSession(ctx, room._id);
    if (existing && existing.status !== "ended") {
      return existing;
    }

    const hostDeviceId = args.hostDeviceId.trim();
    if (!hostDeviceId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "hostDeviceId is required.",
      });
    }

    const workspaceSlug = sanitizeWorkspaceSlug(args.workspaceSlug);
    requireBoundedString(workspaceSlug, "workspaceSlug", MAX_WORKSPACE_SLUG_LENGTH);
    const workspaceFolderName = sanitizeWorkspaceFolderName(
      args.workspaceFolderName?.trim() || workspaceSlug,
    );
    requireBoundedString(
      workspaceFolderName,
      "workspaceFolderName",
      MAX_WORKSPACE_FOLDER_NAME_LENGTH,
    );

    const now = Date.now();
    const sessionId = await ctx.db.insert("stella_sessions", {
      roomId: args.roomId,
      hostOwnerId: ownerId,
      hostDeviceId,
      createdByOwnerId: ownerId,
      workspaceSlug,
      workspaceFolderName,
      conversationId: "pending",
      status: "active",
      latestTurnOrdinal: 0,
      latestFileOpOrdinal: 0,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(sessionId, {
      conversationId: getSocialSessionConversationId(sessionId),
    });
    await createSessionMembers(ctx, sessionId, args.roomId);
    await ctx.db.patch(room._id, {
      stellaSessionId: sessionId,
      updatedAt: now,
    });
    await appendSessionSystemMessage(ctx, {
      roomId: room._id,
      senderOwnerId: ownerId,
      body: "Stella mode started.",
    });

    const created = await ctx.db.get(sessionId);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create Stella session.",
      });
    }
    return created;
  },
});

export const updateSessionStatus = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("ended")),
  },
  returns: stellaSessionValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      status: args.status,
      updatedAt: now,
    });
    if (args.status === "ended") {
      await ctx.db.patch(session.roomId, {
        stellaSessionId: undefined,
        updatedAt: now,
      });
    }
    const updated = await ctx.db.get(session._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update Stella session.",
      });
    }
    return updated;
  },
});

export const listTurns = query({
  args: {
    sessionId: v.id("stella_sessions"),
    limit: v.optional(v.number()),
  },
  returns: v.array(stellaSessionTurnValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), MAX_TURN_LIMIT);
    const turns = await ctx.db
      .query("stella_session_turns")
      .withIndex("by_sessionId_and_ordinal", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(limit);
    return turns.reverse();
  },
});

export const queueTurn = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    prompt: v.string(),
    agentType: v.optional(v.string()),
    clientTurnId: v.optional(v.string()),
  },
  returns: stellaSessionTurnValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await ensureActiveSessionForMember(ctx, args.sessionId, ownerId);
    const prompt = args.prompt.trim();
    if (!prompt) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Prompt is required.",
      });
    }
    ensureSessionAcceptsTurns(session);
    requireBoundedString(prompt, "prompt", MAX_SESSION_TURN_PROMPT_LENGTH);

    const clientTurnId = args.clientTurnId?.trim();
    if (clientTurnId) {
      requireBoundedString(clientTurnId, "clientTurnId", MAX_REQUEST_ID_LENGTH);
      const requestId = `${session._id}:${ownerId}:${clientTurnId}`;
      const existing = await ctx.db
        .query("stella_session_turns")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique();
      if (existing) {
        return existing;
      }
    }

    const nextOrdinal = session.latestTurnOrdinal + 1;
    const now = Date.now();
    const requestId = clientTurnId ? `${session._id}:${ownerId}:${clientTurnId}` : undefined;
    const turnId = await ctx.db.insert("stella_session_turns", {
      sessionId: session._id,
      ordinal: nextOrdinal,
      status: "queued",
      requestedByOwnerId: ownerId,
      requestId,
      prompt,
      agentType: args.agentType?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(session._id, {
      latestTurnOrdinal: nextOrdinal,
      updatedAt: now,
    });
    const created = await ctx.db.get(turnId);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to queue Stella turn.",
      });
    }
    return created;
  },
});

export const listPendingTurnsForHostDevice = query({
  args: {
    deviceId: v.string(),
  },
  returns: v.array(hostTurnSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const deviceId = args.deviceId.trim();
    // Indexed lookup on the exact host owner + device + status — replaces a
    // previous `.collect()` + JS filter over the owner's whole session list.
    const matches = await ctx.db
      .query("stella_sessions")
      .withIndex("by_hostOwnerId_and_hostDeviceId_and_status", (q) =>
        q
          .eq("hostOwnerId", ownerId)
          .eq("hostDeviceId", deviceId)
          .eq("status", "active"),
      )
      .take(MAX_SESSIONS_PER_ROOM_COLLECT);
    const summaries = await Promise.all(
      matches.map(async (session) => {
        const room = await ctx.db.get(session.roomId);
        if (!room) {
          return [];
        }
        const [queuedTurns, claimedTurns] = await Promise.all([
          ctx.db
            .query("stella_session_turns")
            .withIndex("by_sessionId_and_status_and_createdAt", (q) =>
              q.eq("sessionId", session._id).eq("status", "queued"),
            )
            .take(MAX_SESSION_TURNS_COLLECT),
          ctx.db
            .query("stella_session_turns")
            .withIndex("by_sessionId_and_status_and_createdAt", (q) =>
              q.eq("sessionId", session._id).eq("status", "claimed"),
            )
            .take(MAX_SESSION_TURNS_COLLECT),
        ]);
        const resumableTurns = claimedTurns.filter(
          (turn) => turn.claimedByDeviceId === deviceId,
        );
        return [...queuedTurns, ...resumableTurns].map((turn) => ({
          session,
          room,
          turn,
        }));
      }),
    );
    return summaries.flat().sort((left, right) => {
      if (left.turn.createdAt !== right.turn.createdAt) {
        return left.turn.createdAt - right.turn.createdAt;
      }
      return left.turn.ordinal - right.turn.ordinal;
    });
  },
});

export const claimTurn = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    turnId: v.id("stella_session_turns"),
    deviceId: v.string(),
  },
  returns: v.object({
    claimed: v.boolean(),
    turn: v.union(v.null(), stellaSessionTurnValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const deviceId = args.deviceId.trim();
    if (session.hostDeviceId !== deviceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "This device is not the host for the session.",
      });
    }
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.sessionId !== args.sessionId) {
      return { claimed: false, turn: null };
    }
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "canceled") {
      return { claimed: false, turn };
    }
    if (turn.status === "claimed" && turn.claimedByDeviceId === deviceId) {
      return { claimed: true, turn };
    }
    if (turn.status !== "queued") {
      return { claimed: false, turn };
    }
    await ctx.db.patch(turn._id, {
      status: "claimed",
      claimedByDeviceId: deviceId,
      claimedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const claimedTurn = await ctx.db.get(turn._id);
    return {
      claimed: true,
      turn: claimedTurn ?? null,
    };
  },
});

export const completeTurn = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    turnId: v.id("stella_session_turns"),
    deviceId: v.string(),
    resultText: v.string(),
  },
  returns: stellaSessionTurnValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const deviceId = args.deviceId.trim();
    if (session.hostDeviceId !== deviceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "This device is not the host for the session.",
      });
    }
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.sessionId !== args.sessionId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Turn not found.",
      });
    }
    const resultText = args.resultText.trim();
    requireBoundedString(resultText, "resultText", MAX_SESSION_RESULT_LENGTH);
    const now = Date.now();
    await ctx.db.patch(turn._id, {
      status: "completed",
      claimedByDeviceId: deviceId,
      completedAt: now,
      resultText,
      error: undefined,
      updatedAt: now,
    });
    const updated = await ctx.db.get(turn._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to complete Stella turn.",
      });
    }
    await appendSessionSystemMessage(ctx, {
      roomId: session.roomId,
      senderOwnerId: ownerId,
      body: resultText,
    });
    return updated;
  },
});

export const failTurn = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    turnId: v.id("stella_session_turns"),
    deviceId: v.string(),
    error: v.string(),
  },
  returns: stellaSessionTurnValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const deviceId = args.deviceId.trim();
    if (session.hostDeviceId !== deviceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "This device is not the host for the session.",
      });
    }
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.sessionId !== args.sessionId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Turn not found.",
      });
    }
    const error = args.error.trim();
    requireBoundedString(error, "error", 4000);
    const now = Date.now();
    await ctx.db.patch(turn._id, {
      status: "failed",
      claimedByDeviceId: deviceId,
      completedAt: now,
      error,
      updatedAt: now,
    });
    const updated = await ctx.db.get(turn._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to fail Stella turn.",
      });
    }
    return updated;
  },
});

export const releaseTurn = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    turnId: v.id("stella_session_turns"),
    deviceId: v.string(),
  },
  returns: stellaSessionTurnValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const deviceId = args.deviceId.trim();
    if (session.hostDeviceId !== deviceId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "This device is not the host for the session.",
      });
    }
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.sessionId !== args.sessionId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Turn not found.",
      });
    }
    await ctx.db.patch(turn._id, {
      status: "queued",
      claimedByDeviceId: undefined,
      claimedAt: undefined,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(turn._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to release Stella turn.",
      });
    }
    return updated;
  },
});

export const listWorkspaceFiles = query({
  args: {
    sessionId: v.id("stella_sessions"),
  },
  returns: v.array(sessionFileSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    const files = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_relativePath", (q) => q.eq("sessionId", args.sessionId))
      .take(MAX_SESSION_FILES_COLLECT);
    const activeFiles = files.filter((file) => file.deleted === false);
    return await Promise.all(
      activeFiles.map(async (file) => ({
        relativePath: file.relativePath,
        kind: (file.contentHash || file.storageId ? "file" : "directory") as
          | "file"
          | "directory",
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        updatedAt: file.updatedAt,
        downloadUrl: file.storageId ? await ctx.storage.getUrl(file.storageId) ?? undefined : undefined,
      })),
    );
  },
});

export const markFileOpsApplied = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    lastAppliedFileOpOrdinal: v.number(),
  },
  returns: stellaSessionMemberValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const membership = await requireSessionMembership(ctx, args.sessionId, ownerId);
    const session = await getSessionDoc(ctx, args.sessionId);
    const nextOrdinal = Math.max(0, Math.floor(args.lastAppliedFileOpOrdinal));
    if (nextOrdinal > session.latestFileOpOrdinal) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "lastAppliedFileOpOrdinal exceeds the session cursor.",
      });
    }
    if ((membership.lastAppliedFileOpOrdinal ?? 0) === nextOrdinal) {
      return membership;
    }
    const now = Date.now();
    await ctx.db.patch(membership._id, {
      lastAppliedFileOpOrdinal: nextOrdinal,
      updatedAt: now,
    });
    const updated = await ctx.db.get(membership._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update session sync progress.",
      });
    }
    return updated;
  },
});

export const createDirectory = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    relativePath: v.string(),
  },
  returns: v.object({
    ordinal: v.number(),
    noop: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    if (session.status === "ended") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Session is no longer active.",
      });
    }

    const relativePath = normalizeRelativeSessionPath(args.relativePath);
    const currentEntry = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_relativePath", (q) =>
        q.eq("sessionId", args.sessionId).eq("relativePath", relativePath),
      )
      .unique();
    if (
      currentEntry
      && currentEntry.deleted === false
      && !currentEntry.contentHash
      && !currentEntry.storageId
    ) {
      return {
        ordinal: session.latestFileOpOrdinal,
        noop: true,
      };
    }

    const nextOrdinal = session.latestFileOpOrdinal + 1;
    const timestamp = Date.now();
    if (currentEntry) {
      await ctx.db.patch(currentEntry._id, {
        deleted: false,
        updatedAt: timestamp,
        storageId: undefined,
        contentHash: undefined,
        sizeBytes: undefined,
        contentType: undefined,
      });
    } else {
      await ctx.db.insert("stella_session_files", {
        sessionId: args.sessionId,
        relativePath,
        deleted: false,
        updatedAt: timestamp,
      });
    }
    await ctx.db.insert("stella_session_file_ops", {
      sessionId: args.sessionId,
      ordinal: nextOrdinal,
      type: "mkdir",
      relativePath,
      actorOwnerId: ownerId,
      createdAt: timestamp,
    });
    await ctx.db.patch(session._id, {
      latestFileOpOrdinal: nextOrdinal,
      updatedAt: timestamp,
    });
    return {
      ordinal: nextOrdinal,
      noop: false,
    };
  },
});

export const listFileOps = query({
  args: {
    sessionId: v.id("stella_sessions"),
    afterOrdinal: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(sessionFileOpSummaryValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    const afterOrdinal = Math.max(0, Math.floor(args.afterOrdinal ?? 0));
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 200), 1), MAX_FILE_OP_LIMIT);
    const ops = await ctx.db
      .query("stella_session_file_ops")
      .withIndex("by_sessionId_and_ordinal", (q) =>
        q.eq("sessionId", args.sessionId).gt("ordinal", afterOrdinal),
      )
      .take(limit);
    return await Promise.all(
      ops.map(async (op) => ({
        op,
        downloadUrl: op.storageId ? await ctx.storage.getUrl(op.storageId) ?? undefined : undefined,
      })),
    );
  },
});

export const markSnapshotCreated = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
  },
  returns: stellaSessionValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      lastSnapshotAt: now,
      updatedAt: now,
    });
    const updated = await ctx.db.get(session._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to mark session snapshot metadata.",
      });
    }
    return updated;
  },
});

export const acknowledgeFileOps = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    lastAppliedOrdinal: v.number(),
  },
  returns: v.object({
    ok: v.boolean(),
    lastAppliedOrdinal: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const membership = await requireSessionMembership(ctx, args.sessionId, ownerId);
    const session = await getSessionDoc(ctx, args.sessionId);
    const lastAppliedOrdinal = Math.max(
      0,
      Math.min(
        session.latestFileOpOrdinal,
        Math.floor(args.lastAppliedOrdinal),
      ),
    );
    await ctx.db.patch(membership._id, {
      lastAppliedFileOpOrdinal: lastAppliedOrdinal,
      updatedAt: Date.now(),
    });
    return {
      ok: true,
      lastAppliedOrdinal,
    };
  },
});

export const deleteFile = mutation({
  args: {
    sessionId: v.id("stella_sessions"),
    relativePath: v.string(),
  },
  returns: v.object({
    ordinal: v.number(),
    noop: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    const session = await requireSessionHost(ctx, args.sessionId, ownerId);
    if (session.status === "ended") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Session is no longer active.",
      });
    }

    const relativePath = normalizeRelativeSessionPath(args.relativePath);
    const currentEntry = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_relativePath", (q) =>
        q.eq("sessionId", args.sessionId).eq("relativePath", relativePath),
      )
      .unique();
    if (!currentEntry || currentEntry.deleted) {
      return {
        ordinal: session.latestFileOpOrdinal,
        noop: true,
      };
    }

    const nextOrdinal = session.latestFileOpOrdinal + 1;
    const timestamp = Date.now();
    await ctx.db.patch(currentEntry._id, {
      deleted: true,
      updatedAt: timestamp,
      storageId: undefined,
      contentHash: undefined,
      sizeBytes: undefined,
      contentType: undefined,
    });
    await ctx.db.insert("stella_session_file_ops", {
      sessionId: args.sessionId,
      ordinal: nextOrdinal,
      type: "delete",
      relativePath,
      actorOwnerId: ownerId,
      createdAt: timestamp,
    });
    await ctx.db.patch(session._id, {
      latestFileOpOrdinal: nextOrdinal,
      updatedAt: timestamp,
    });
    return {
      ordinal: nextOrdinal,
      noop: false,
    };
  },
});

export const uploadFile = action({
  args: {
    sessionId: v.id("stella_sessions"),
    relativePath: v.string(),
    contentBase64: v.string(),
    contentHash: v.string(),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    ordinal: v.number(),
    noop: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ ordinal: number; noop: boolean }> => {
    const ownerId = await requireConnectedSocialUserIdAction(ctx);
    const session: Doc<"stella_sessions"> | null = await ctx.runQuery(
      internal.social.sessions.getSessionInternal,
      {
      sessionId: args.sessionId,
      },
    );
    if (!session) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Session not found.",
      });
    }
    if (session.hostOwnerId !== ownerId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the session host can upload files.",
      });
    }

    const relativePath = normalizeRelativeSessionPath(args.relativePath);
    const contentHash = args.contentHash.trim();
    if (!contentHash) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "contentHash is required.",
      });
    }
    requireBoundedString(contentHash, "contentHash", MAX_CONTENT_HASH_LENGTH);
    requireBoundedString(args.contentBase64, "contentBase64", MAX_BASE64_LENGTH);
    const contentType = args.contentType?.trim() || "application/octet-stream";
    requireBoundedString(contentType, "contentType", MAX_FILE_CONTENT_TYPE_LENGTH);

    const bytes = parseBase64Bytes(args.contentBase64);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `File exceeds maximum supported size of ${MAX_FILE_BYTES} bytes.`,
      });
    }

    const existingBlob: {
      storageId: Id<"_storage">;
      sizeBytes: number;
      contentType: string;
    } | null = await ctx.runQuery(internal.social.sessions.getFileBlobByHashInternal, {
      sessionId: args.sessionId,
      contentHash,
    });
    const storageId: Id<"_storage"> =
      existingBlob?.storageId
      ?? await ctx.storage.store(
        (() => {
          const copiedBytes = new Uint8Array(bytes.byteLength);
          copiedBytes.set(bytes);
          return new Blob([copiedBytes.buffer as ArrayBuffer], {
            type: contentType,
          });
        })(),
      );

    return await ctx.runMutation(internal.social.sessions.recordFileUploadInternal, {
      sessionId: args.sessionId,
      ownerId,
      relativePath,
      contentHash,
      storageId,
      sizeBytes: bytes.byteLength,
      contentType,
    });
  },
});
