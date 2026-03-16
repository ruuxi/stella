import type { MutationCtx, QueryCtx, ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  requireBoundedString,
} from "../shared_validators";
import {
  requireConnectedUserId,
  requireConnectedUserIdAction,
} from "../auth";

const FRIEND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const FRIEND_CODE_LENGTH = 8;
const MAX_FRIEND_CODE_RETRIES = 24;

const NICKNAME_ADJECTIVES = [
  "Brisk",
  "Calm",
  "Clever",
  "Curious",
  "Daring",
  "Gentle",
  "Lively",
  "Lucky",
  "Mellow",
  "Nova",
  "Quiet",
  "Radiant",
  "Solar",
  "Swift",
];

const NICKNAME_NOUNS = [
  "Aurora",
  "Comet",
  "Falcon",
  "Harbor",
  "Maple",
  "Otter",
  "Panda",
  "Robin",
  "Sparrow",
  "Tide",
  "Willow",
  "Zephyr",
];

export const socialProfileValidator = v.object({
  _id: v.id("social_profiles"),
  _creationTime: v.number(),
  ownerId: v.string(),
  nickname: v.string(),
  nicknameNormalized: v.string(),
  friendCode: v.string(),
  avatarUrl: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const socialRelationshipValidator = v.object({
  _id: v.id("social_relationships"),
  _creationTime: v.number(),
  relationshipKey: v.string(),
  lowOwnerId: v.string(),
  highOwnerId: v.string(),
  requesterOwnerId: v.string(),
  addresseeOwnerId: v.string(),
  initiatedByOwnerId: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("accepted"),
    v.literal("declined"),
    v.literal("blocked"),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
  respondedAt: v.optional(v.number()),
});

export const socialRoomValidator = v.object({
  _id: v.id("social_rooms"),
  _creationTime: v.number(),
  kind: v.union(v.literal("dm"), v.literal("group")),
  roomKey: v.optional(v.string()),
  title: v.optional(v.string()),
  createdByOwnerId: v.string(),
  stellaSessionId: v.optional(v.id("stella_sessions")),
  createdAt: v.number(),
  updatedAt: v.number(),
  latestMessageAt: v.optional(v.number()),
});

export const socialRoomMemberValidator = v.object({
  _id: v.id("social_room_members"),
  _creationTime: v.number(),
  roomId: v.id("social_rooms"),
  ownerId: v.string(),
  role: v.union(v.literal("owner"), v.literal("member")),
  joinedAt: v.number(),
  lastReadMessageId: v.optional(v.id("social_messages")),
  lastReadAt: v.optional(v.number()),
  updatedAt: v.number(),
});

export const socialMessageValidator = v.object({
  _id: v.id("social_messages"),
  _creationTime: v.number(),
  roomId: v.id("social_rooms"),
  senderOwnerId: v.string(),
  clientMessageId: v.optional(v.string()),
  kind: v.union(v.literal("text"), v.literal("system")),
  body: v.string(),
  createdAt: v.number(),
  editedAt: v.optional(v.number()),
});

export const stellaSessionValidator = v.object({
  _id: v.id("stella_sessions"),
  _creationTime: v.number(),
  roomId: v.id("social_rooms"),
  hostOwnerId: v.string(),
  hostDeviceId: v.string(),
  createdByOwnerId: v.string(),
  workspaceSlug: v.string(),
  workspaceFolderName: v.string(),
  conversationId: v.string(),
  status: v.union(v.literal("active"), v.literal("paused"), v.literal("ended")),
  latestTurnOrdinal: v.number(),
  latestFileOpOrdinal: v.number(),
  lastSnapshotAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const stellaSessionTurnValidator = v.object({
  _id: v.id("stella_session_turns"),
  _creationTime: v.number(),
  sessionId: v.id("stella_sessions"),
  ordinal: v.number(),
  status: v.union(
    v.literal("queued"),
    v.literal("claimed"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
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
});

export const stellaSessionMemberValidator = v.object({
  _id: v.id("stella_session_members"),
  _creationTime: v.number(),
  sessionId: v.id("stella_sessions"),
  ownerId: v.string(),
  joinedAt: v.number(),
  lastAppliedFileOpOrdinal: v.optional(v.number()),
  updatedAt: v.number(),
});

export const stellaSessionFileOpValidator = v.object({
  _id: v.id("stella_session_file_ops"),
  _creationTime: v.number(),
  sessionId: v.id("stella_sessions"),
  ordinal: v.number(),
  type: v.union(v.literal("upsert"), v.literal("delete"), v.literal("mkdir")),
  relativePath: v.string(),
  actorOwnerId: v.string(),
  contentHash: v.optional(v.string()),
  storageId: v.optional(v.id("_storage")),
  sizeBytes: v.optional(v.number()),
  contentType: v.optional(v.string()),
  createdAt: v.number(),
});

type AnyCtx = QueryCtx | MutationCtx;

export const normalizeNickname = (value: string) =>
  value.trim().replace(/\s+/g, " ").slice(0, 40);

export const normalizeNicknameKey = (value: string) =>
  normalizeNickname(value).toLowerCase();

export const sanitizeWorkspaceSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const sanitizeWorkspaceFolderName = (value: string) =>
  value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);

export const normalizeRelativeSessionPath = (value: string) => {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "relativePath is required",
    });
  }
  const parts = trimmed
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "relativePath is required",
    });
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "relativePath must stay within the session workspace",
      });
    }
  }
  const normalized = parts.join("/");
  requireBoundedString(normalized, "relativePath", 512);
  return normalized;
};

export const ensureSocialProfileDoc = async (
  ctx: MutationCtx,
  ownerId: string,
): Promise<Doc<"social_profiles">> => {
  const existing = await ctx.db
    .query("social_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const nickname = generateDefaultNickname();
  const friendCode = await generateUniqueFriendCode(ctx);
  const id = await ctx.db.insert("social_profiles", {
    ownerId,
    nickname,
    nicknameNormalized: normalizeNicknameKey(nickname),
    friendCode,
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (!created) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to create social profile",
    });
  }
  return created;
};

export const requireSocialProfile = async (
  ctx: MutationCtx,
): Promise<Doc<"social_profiles">> => {
  const ownerId = await requireConnectedUserId(ctx);
  return await ensureSocialProfileDoc(ctx, ownerId);
};

export const getSocialProfileByOwnerId = async (
  ctx: AnyCtx,
  ownerId: string,
) =>
  await ctx.db
    .query("social_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

export const requireSocialProfileByOwnerId = async (
  ctx: MutationCtx,
  ownerId: string,
) => {
  const profile = await ensureSocialProfileDoc(ctx, ownerId);
  return profile;
};

export const getRelationshipKey = (leftOwnerId: string, rightOwnerId: string) =>
  [leftOwnerId, rightOwnerId].sort((a, b) => a.localeCompare(b)).join(":");

export const loadRelationship = async (
  ctx: AnyCtx,
  leftOwnerId: string,
  rightOwnerId: string,
) =>
  await ctx.db
    .query("social_relationships")
    .withIndex("by_relationshipKey", (q) =>
      q.eq("relationshipKey", getRelationshipKey(leftOwnerId, rightOwnerId)),
    )
    .unique();

export const ensureRelationshipIsAccepted = (
  relationship: Doc<"social_relationships"> | null,
) => {
  if (!relationship || relationship.status !== "accepted") {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only friends can perform this action",
    });
  }
};

export const requireRoomMembership = async (
  ctx: AnyCtx,
  roomId: Id<"social_rooms">,
  ownerId: string,
) => {
  const membership = await ctx.db
    .query("social_room_members")
    .withIndex("by_roomId_and_ownerId", (q) =>
      q.eq("roomId", roomId).eq("ownerId", ownerId),
    )
    .unique();
  if (!membership) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Room not found",
    });
  }
  return membership;
};

export const requireSessionMembership = async (
  ctx: AnyCtx,
  sessionId: Id<"stella_sessions">,
  ownerId: string,
) => {
  const membership = await ctx.db
    .query("stella_session_members")
    .withIndex("by_sessionId_and_ownerId", (q) =>
      q.eq("sessionId", sessionId).eq("ownerId", ownerId),
    )
    .unique();
  if (!membership) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Session not found",
    });
  }
  return membership;
};

export const requireSessionHost = async (
  ctx: AnyCtx,
  sessionId: Id<"stella_sessions">,
  ownerId: string,
) => {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Session not found",
    });
  }
  if (session.hostOwnerId !== ownerId) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only the session host can perform this action",
    });
  }
  return session;
};

export const listAcceptedRelationshipsForOwner = async (
  ctx: AnyCtx,
  ownerId: string,
) => {
  const [low, high] = await Promise.all([
    ctx.db
      .query("social_relationships")
      .withIndex("by_lowOwnerId_and_status", (q) =>
        q.eq("lowOwnerId", ownerId).eq("status", "accepted"),
      )
      .collect(),
    ctx.db
      .query("social_relationships")
      .withIndex("by_highOwnerId_and_status", (q) =>
        q.eq("highOwnerId", ownerId).eq("status", "accepted"),
      )
      .collect(),
  ]);
  return [...low, ...high];
};

export const getSocialSessionConversationId = (sessionId: Id<"stella_sessions">) =>
  `social:stella:${sessionId}`;

const generateDefaultNickname = () => {
  const adjective =
    NICKNAME_ADJECTIVES[Math.floor(Math.random() * NICKNAME_ADJECTIVES.length)]!;
  const noun =
    NICKNAME_NOUNS[Math.floor(Math.random() * NICKNAME_NOUNS.length)]!;
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${adjective} ${noun} ${suffix}`;
};

const generateFriendCodeCandidate = () => {
  let output = "";
  for (let index = 0; index < FRIEND_CODE_LENGTH; index += 1) {
    output += FRIEND_CODE_ALPHABET[Math.floor(Math.random() * FRIEND_CODE_ALPHABET.length)];
  }
  return output;
};

const generateUniqueFriendCode = async (ctx: MutationCtx): Promise<string> => {
  for (let attempt = 0; attempt < MAX_FRIEND_CODE_RETRIES; attempt += 1) {
    const candidate = generateFriendCodeCandidate();
    const existing = await ctx.db
      .query("social_profiles")
      .withIndex("by_friendCode", (q) => q.eq("friendCode", candidate))
      .unique();
    if (!existing) {
      return candidate;
    }
  }
  throw new ConvexError({
    code: "INTERNAL_ERROR",
    message: "Failed to allocate a unique friend code",
  });
};

export const requireConnectedSocialUserId = async (ctx: MutationCtx) => {
  const ownerId = await requireConnectedUserId(ctx);
  await ensureSocialProfileDoc(ctx, ownerId);
  return ownerId;
};

export const requireConnectedSocialUserIdAction = async (ctx: ActionCtx) => {
  const ownerId = await requireConnectedUserIdAction(ctx);
  return ownerId;
};

export const linkSessionToRoom = async (
  ctx: MutationCtx,
  roomId: Id<"social_rooms">,
  sessionId: Id<"stella_sessions">,
) => {
  await ctx.db.patch(roomId, {
    stellaSessionId: sessionId,
    updatedAt: Date.now(),
  });
};

export const refreshRoomUpdatedAt = async (
  ctx: MutationCtx,
  roomId: Id<"social_rooms">,
  timestamp: number,
) => {
  await ctx.db.patch(roomId, {
    updatedAt: timestamp,
    latestMessageAt: timestamp,
  });
};
