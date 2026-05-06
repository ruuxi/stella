import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
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
  requireSessionHostDevice,
  requireSessionMembership,
  requireSessionTurn,
  sanitizeWorkspaceSlug,
  sanitizeWorkspaceFolderName,
  normalizeRelativeSessionPath,
  getSocialSessionConversationId,
} from "./shared";
import { getConnectedUserIdOrNull, requireConnectedUserId } from "../auth";
import { clampPageLimit, requireBoundedString } from "../shared_validators";
import {
  enforceActionRateLimit,
  enforceMutationRateLimit,
  RATE_EXPENSIVE,
  RATE_HOT_PATH,
  RATE_STANDARD,
} from "../lib/rate_limits";

const MAX_WORKSPACE_SLUG_LENGTH = 48;
const MAX_WORKSPACE_FOLDER_NAME_LENGTH = 80;
// Per-page ceiling for `listTurns`. Desktop hook requests 20/page; this
// is a safety cap, not the steady-state size.
const MAX_TURNS_PER_PAGE = 50;
const MAX_FILE_OP_LIMIT = 500;
const MAX_FILE_BYTES = 700_000;
const MAX_SESSIONS_PER_ROOM_COLLECT = 100;
const MAX_ROOM_MEMBERS_COLLECT = 500;
const MAX_SESSION_TURNS_COLLECT = 500;
const MAX_BASE64_LENGTH = 950_000;
const MAX_SESSION_TURN_PROMPT_LENGTH = 20_000;
const MAX_SESSION_RESULT_LENGTH = 100_000;
const MAX_FILE_CONTENT_TYPE_LENGTH = 200;
const MAX_CONTENT_HASH_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 200;

const optionalSessionValidator = v.union(v.null(), stellaSessionValidator);

const paginatedSessionTurnsValidator = v.object({
  page: v.array(stellaSessionTurnValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(
      v.literal("SplitRecommended"),
      v.literal("SplitRequired"),
      v.null(),
    ),
  ),
});

const emptyTurnsPage = (): {
  page: never[];
  isDone: true;
  continueCursor: "";
} => ({ page: [], isDone: true, continueCursor: "" });

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

const appendSessionFileOp = async (
  ctx: MutationCtx,
  args: {
    session: Doc<"stella_sessions">;
    type: "upsert" | "delete" | "mkdir";
    relativePath: string;
    actorOwnerId: string;
    contentHash?: string;
    storageId?: Id<"_storage">;
    sizeBytes?: number;
    contentType?: string;
    timestamp?: number;
  },
): Promise<{ ordinal: number; timestamp: number }> => {
  const ordinal = args.session.latestFileOpOrdinal + 1;
  const timestamp = args.timestamp ?? Date.now();
  await ctx.db.insert("stella_session_file_ops", {
    sessionId: args.session._id,
    ordinal,
    type: args.type,
    relativePath: args.relativePath,
    actorOwnerId: args.actorOwnerId,
    contentHash: args.contentHash,
    storageId: args.storageId,
    sizeBytes: args.sizeBytes,
    contentType: args.contentType,
    createdAt: timestamp,
  });
  await ctx.db.patch(args.session._id, {
    latestFileOpOrdinal: ordinal,
    updatedAt: timestamp,
  });
  return { ordinal, timestamp };
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

/**
 * Build a `roomSummaryValidator`-shaped response for a session.
 *
 * Callers must have already proven the viewer is a session member (e.g. the
 * `listSessions` map iterates `stella_session_members` rows, and `getSession`
 * does an explicit membership lookup). We therefore only need to fetch the
 * room doc and the room-level role here — re-querying session membership
 * inside this helper would be N×M reads against the same index data the
 * caller already saw.
 */
const createSessionSummary = async (
  ctx: QueryCtx,
  session: Doc<"stella_sessions">,
  ownerId: string,
) => {
  const room = await getRoomDoc(ctx, session.roomId);
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

    const op = await appendSessionFileOp(ctx, {
      session,
      type: "upsert",
      relativePath: args.relativePath,
      actorOwnerId: args.ownerId,
      contentHash: args.contentHash,
      storageId: args.storageId,
      sizeBytes: args.sizeBytes,
      contentType: args.contentType,
      timestamp,
    });

    return {
      ordinal: op.ordinal,
      noop: false,
    };
  },
});

export const listSessions = query({
  args: {},
  returns: v.array(roomSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
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
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return null;
    }
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
    await enforceMutationRateLimit(
      ctx,
      "session_create",
      ownerId,
      RATE_STANDARD,
      "Too many session start attempts. Please wait a moment and try again.",
    );
    await requireRoomMembership(ctx, args.roomId, ownerId);
    const room = await getRoomDoc(ctx, args.roomId);
    if (room.kind === "global") {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Shared Stella is not available in Global Chat.",
      });
    }

    const hostDeviceId = args.hostDeviceId.trim();
    if (!hostDeviceId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "hostDeviceId is required.",
      });
    }

    const existing = room.stellaSessionId
      ? await ctx.db.get(room.stellaSessionId)
      : await resolveActiveRoomSession(ctx, room._id);
    if (existing && existing.status !== "ended") {
      if (
        existing.hostOwnerId === ownerId &&
        existing.hostDeviceId !== hostDeviceId
      ) {
        const now = Date.now();
        await ctx.db.patch(existing._id, {
          hostDeviceId,
          updatedAt: now,
        });
        const staleClaimedTurns = await ctx.db
          .query("stella_session_turns")
          .withIndex("by_sessionId_and_status_and_createdAt", (q) =>
            q.eq("sessionId", existing._id).eq("status", "claimed"),
          )
          .take(MAX_SESSION_TURNS_COLLECT);
        await Promise.all(
          staleClaimedTurns
            .filter((turn) => turn.claimedByDeviceId !== hostDeviceId)
            .map((turn) =>
              ctx.db.patch(turn._id, {
                status: "queued",
                claimedByDeviceId: undefined,
                claimedAt: undefined,
                updatedAt: now,
              }),
            ),
        );
        const updated = await ctx.db.get(existing._id);
        return updated ?? existing;
      }
      return existing;
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
    await enforceMutationRateLimit(
      ctx,
      "session_update_status",
      ownerId,
      RATE_STANDARD,
    );
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
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedSessionTurnsValidator,
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return emptyTurnsPage();
    }
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    const numItems = Math.min(
      Math.max(args.paginationOpts.numItems, 1),
      MAX_TURNS_PER_PAGE,
    );
    // Order desc on `ordinal` so each page is the next-older slice; the
    // renderer re-sorts to chronological order for display.
    return await ctx.db
      .query("stella_session_turns")
      .withIndex("by_sessionId_and_ordinal", (q) =>
        q.eq("sessionId", args.sessionId),
      )
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems,
      });
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
    // Each queued turn schedules agent work on the host. Treat like a
    // standard chat send.
    await enforceMutationRateLimit(
      ctx,
      "session_queue_turn",
      ownerId,
      RATE_STANDARD,
      "Too many turn requests. Please slow down and try again.",
    );
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
    const requestId = clientTurnId
      ? `${session._id}:${ownerId}:${clientTurnId}`
      : undefined;
    if (clientTurnId && requestId) {
      requireBoundedString(clientTurnId, "clientTurnId", MAX_REQUEST_ID_LENGTH);
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
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
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
    // Hot path: host devices poll/claim turns. Use the loose hot-path tier.
    await enforceMutationRateLimit(
      ctx,
      "session_claim_turn",
      ownerId,
      RATE_HOT_PATH,
    );
    const { deviceId } = await requireSessionHostDevice(ctx, args.sessionId, ownerId, args.deviceId);
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
    await enforceMutationRateLimit(
      ctx,
      "session_complete_turn",
      ownerId,
      RATE_HOT_PATH,
    );
    const { session, deviceId } = await requireSessionHostDevice(ctx, args.sessionId, ownerId, args.deviceId);
    const turn = await requireSessionTurn(ctx, args.sessionId, args.turnId);
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
    await enforceMutationRateLimit(
      ctx,
      "session_fail_turn",
      ownerId,
      RATE_HOT_PATH,
    );
    const { deviceId } = await requireSessionHostDevice(ctx, args.sessionId, ownerId, args.deviceId);
    const turn = await requireSessionTurn(ctx, args.sessionId, args.turnId);
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
    await enforceMutationRateLimit(
      ctx,
      "session_release_turn",
      ownerId,
      RATE_HOT_PATH,
    );
    const { deviceId } = await requireSessionHostDevice(ctx, args.sessionId, ownerId, args.deviceId);
    const turn = await requireSessionTurn(ctx, args.sessionId, args.turnId);
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

/**
 * Per-page cap for `listWorkspaceFiles`. Stays well below the array-return
 * limit so a session with many active files paginates instead of failing.
 */
const WORKSPACE_FILES_PAGE_SIZE = 200;

export const listWorkspaceFiles = query({
  args: {
    sessionId: v.id("stella_sessions"),
    /**
     * Optional cursor returned by a previous page. When omitted, the query
     * starts at the first page of live files.
     */
    cursor: v.optional(v.union(v.string(), v.null())),
    /**
     * Sign storage URLs server-side. Off by default because the URLs expire
     * and signing every entry on every refetch makes the query slow and
     * defeats reactive caching. Callers that need a download URL should
     * fetch it on demand via a separate mutation.
     */
    includeDownloadUrls: v.optional(v.boolean()),
  },
  returns: v.object({
    page: v.array(sessionFileSummaryValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    // Index keyed on (sessionId, deleted, relativePath) lets us skip
    // tombstoned rows entirely instead of scanning + JS-filtering.
    const page = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_deleted_and_relativePath", (q) =>
        q.eq("sessionId", args.sessionId).eq("deleted", false),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: WORKSPACE_FILES_PAGE_SIZE,
      });

    const wantsUrls = args.includeDownloadUrls === true;
    const summaries = await Promise.all(
      page.page.map(async (file) => ({
        relativePath: file.relativePath,
        kind: (file.contentHash || file.storageId ? "file" : "directory") as
          | "file"
          | "directory",
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        updatedAt: file.updatedAt,
        downloadUrl:
          wantsUrls && file.storageId
            ? (await ctx.storage.getUrl(file.storageId)) ?? undefined
            : undefined,
      })),
    );

    return {
      page: summaries,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
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
    await enforceMutationRateLimit(
      ctx,
      "session_mark_file_ops_applied",
      ownerId,
      RATE_HOT_PATH,
    );
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
    await enforceMutationRateLimit(
      ctx,
      "session_create_directory",
      ownerId,
      RATE_HOT_PATH,
    );
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
    const op = await appendSessionFileOp(ctx, {
      session,
      type: "mkdir",
      relativePath,
      actorOwnerId: ownerId,
      timestamp,
    });
    return {
      ordinal: op.ordinal,
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
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    await requireSessionMembership(ctx, args.sessionId, ownerId);
    const afterOrdinal = Math.max(0, Math.floor(args.afterOrdinal ?? 0));
    const limit = clampPageLimit(args.limit, 200, MAX_FILE_OP_LIMIT);
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
    await enforceMutationRateLimit(
      ctx,
      "session_mark_snapshot_created",
      ownerId,
      RATE_STANDARD,
    );
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
    await enforceMutationRateLimit(
      ctx,
      "session_acknowledge_file_ops",
      ownerId,
      RATE_HOT_PATH,
    );
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
    await enforceMutationRateLimit(
      ctx,
      "session_delete_file",
      ownerId,
      RATE_HOT_PATH,
    );
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

    const timestamp = Date.now();
    await ctx.db.patch(currentEntry._id, {
      deleted: true,
      updatedAt: timestamp,
      storageId: undefined,
      contentHash: undefined,
      sizeBytes: undefined,
      contentType: undefined,
    });
    const op = await appendSessionFileOp(ctx, {
      session,
      type: "delete",
      relativePath,
      actorOwnerId: ownerId,
      timestamp,
    });
    return {
      ordinal: op.ordinal,
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
    // Each call writes bytes (up to ~700 KB) into Convex storage. Cap so a
    // host device that's been compromised can't inflate the storage bill.
    await enforceActionRateLimit(
      ctx,
      "session_upload_file",
      ownerId,
      RATE_EXPENSIVE,
      "Too many file uploads. Please wait a moment and try again.",
    );
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
