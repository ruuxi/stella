import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import type { Doc, Id } from '../_generated/dataModel'
import { ConvexError, v } from 'convex/values'
import {
  socialMessageValidator,
  socialProfileValidator,
  socialRoomMemberValidator,
  socialRoomValidator,
  ensureRelationshipIsAccepted,
  ensureSocialProfileDoc,
  getRelationshipKey,
  getSocialProfileByOwnerId,
  listAcceptedRelationshipsForOwner,
  loadRelationship,
  requireRoomMembership,
} from './shared'
import { requireBoundedString } from '../shared_validators'
import { getConnectedUserIdOrNull, requireConnectedUserId } from '../auth'
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_STANDARD,
  RATE_VERY_EXPENSIVE,
} from '../lib/rate_limits'

const roomSummaryValidator = v.object({
  room: socialRoomValidator,
  membership: socialRoomMemberValidator,
  latestMessage: v.union(v.null(), socialMessageValidator),
  memberProfiles: v.array(socialProfileValidator),
})

const optionalRoomSummaryValidator = v.union(v.null(), roomSummaryValidator)

// Cap on member rows hydrated for a single room summary. Group rooms can grow,
// so this keeps the query bounded; over-cap rooms simply truncate the
// member-profile preview.
const MAX_ROOM_MEMBERS_HYDRATED = 500

// Well-known room key + title for the singleton public chat that any signed-in
// user can join.
const GLOBAL_ROOM_KEY = 'global'
const GLOBAL_ROOM_TITLE = 'Global Chat'

type SocialProfileCache = Map<string, Promise<Doc<'social_profiles'> | null>>

const getCachedSocialProfileByOwnerId = async (
  ctx: QueryCtx,
  cache: SocialProfileCache | undefined,
  ownerId: string,
) => {
  if (!cache) {
    return await getSocialProfileByOwnerId(ctx, ownerId)
  }
  let pending = cache.get(ownerId)
  if (!pending) {
    pending = getSocialProfileByOwnerId(ctx, ownerId)
    cache.set(ownerId, pending)
  }
  return await pending
}

const hydrateRoomSummary = async (
  ctx: QueryCtx,
  room: Doc<'social_rooms'> | null,
  membership: Doc<'social_room_members'>,
  profileCache?: SocialProfileCache,
) => {
  if (!room) {
    return null
  }
  // The global room is open to every signed-in user, so the membership table
  // would grow without bound; skip member hydration there and let the chat UI
  // resolve sender profiles on demand via `getProfilesByOwnerIds`.
  const isGlobalRoom = room.kind === 'global'
  const [memberDocs, latestMessage] = await Promise.all([
    isGlobalRoom
      ? Promise.resolve([] as Doc<'social_room_members'>[])
      : ctx.db
          .query('social_room_members')
          .withIndex('by_roomId_and_joinedAt', (q) => q.eq('roomId', room._id))
          .take(MAX_ROOM_MEMBERS_HYDRATED),
    ctx.db
      .query('social_messages')
      .withIndex('by_roomId_and_createdAt', (q) => q.eq('roomId', room._id))
      .order('desc')
      .first(),
  ])
  const memberProfiles = await Promise.all(
    memberDocs.map(
      async (member) =>
        await getCachedSocialProfileByOwnerId(
          ctx,
          profileCache,
          member.ownerId,
        ),
    ),
  )
  return {
    room,
    membership,
    latestMessage: latestMessage ?? null,
    memberProfiles: memberProfiles.filter(
      (profile): profile is NonNullable<typeof profile> => Boolean(profile),
    ),
  }
}

const assertRoomOwnerRole = (membership: { role: 'owner' | 'member' }) => {
  if (membership.role !== 'owner') {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'Only the room owner can perform this action',
    })
  }
}

const createRoomMembership = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
  role: 'owner' | 'member',
) => {
  const now = Date.now()
  return await ctx.db.insert('social_room_members', {
    roomId,
    ownerId,
    role,
    joinedAt: now,
    updatedAt: now,
  })
}

const attachMemberToActiveSession = async (
  ctx: MutationCtx,
  roomId: Id<'social_rooms'>,
  ownerId: string,
) => {
  const room = await ctx.db.get(roomId)
  if (!room?.stellaSessionId) {
    return
  }
  const session = await ctx.db.get(room.stellaSessionId)
  if (!session || session.status === 'ended') {
    return
  }
  const existingMembership = await ctx.db
    .query('stella_session_members')
    .withIndex('by_sessionId_and_ownerId', (q) =>
      q.eq('sessionId', session._id).eq('ownerId', ownerId),
    )
    .unique()
  if (existingMembership) {
    return
  }
  const now = Date.now()
  await ctx.db.insert('stella_session_members', {
    sessionId: session._id,
    ownerId,
    joinedAt: now,
    lastAppliedFileOpOrdinal: 0,
    updatedAt: now,
  })
}

export const listRooms = query({
  args: {},
  returns: v.array(roomSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx)
    if (!ownerId) {
      return []
    }
    const memberships = await ctx.db
      .query('social_room_members')
      .withIndex('by_ownerId_and_updatedAt', (q) => q.eq('ownerId', ownerId))
      .order('desc')
      .take(200)
    const profileCache: SocialProfileCache = new Map()
    const summaries = await Promise.all(
      memberships.map(async (membership) => {
        const room = await ctx.db.get(membership.roomId)
        return await hydrateRoomSummary(ctx, room, membership, profileCache)
      }),
    )
    // Global Chat is rendered as a pinned entry in the sidebar; exclude it
    // from the per-user room list so it isn't shown twice.
    return summaries.filter(
      (entry): entry is NonNullable<typeof entry> =>
        Boolean(entry) && entry!.room.kind !== 'global',
    )
  },
})

export const getGlobalRoomSummary = query({
  args: {},
  returns: optionalRoomSummaryValidator,
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx)
    if (!ownerId) {
      return null
    }
    const room = await ctx.db
      .query('social_rooms')
      .withIndex('by_roomKey', (q) => q.eq('roomKey', GLOBAL_ROOM_KEY))
      .unique()
    if (!room || room.kind !== 'global') {
      return null
    }
    const membership = await ctx.db
      .query('social_room_members')
      .withIndex('by_roomId_and_ownerId', (q) =>
        q.eq('roomId', room._id).eq('ownerId', ownerId),
      )
      .unique()
    if (!membership) {
      return null
    }
    return await hydrateRoomSummary(ctx, room, membership)
  },
})

export const getOrJoinGlobalRoom = mutation({
  args: {},
  returns: socialRoomValidator,
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_join_global_room',
      ownerId,
      RATE_STANDARD,
      'Too many requests. Please slow down and try again.',
    )
    await ensureSocialProfileDoc(ctx, ownerId)

    const existing = await ctx.db
      .query('social_rooms')
      .withIndex('by_roomKey', (q) => q.eq('roomKey', GLOBAL_ROOM_KEY))
      .unique()
    let room: Doc<'social_rooms'> | null = existing
    const now = Date.now()
    if (!room) {
      const roomId = await ctx.db.insert('social_rooms', {
        kind: 'global',
        roomKey: GLOBAL_ROOM_KEY,
        title: GLOBAL_ROOM_TITLE,
        createdByOwnerId: ownerId,
        createdAt: now,
        updatedAt: now,
        latestMessageAt: now,
      })
      room = await ctx.db.get(roomId)
    }
    if (!room) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to load Global Chat',
      })
    }

    const membership = await ctx.db
      .query('social_room_members')
      .withIndex('by_roomId_and_ownerId', (q) =>
        q.eq('roomId', room!._id).eq('ownerId', ownerId),
      )
      .unique()
    if (!membership) {
      // Anyone can join Global Chat; first joiner becomes a regular member.
      // The very first message ever sent will create the singleton via the
      // `createdByOwnerId` field above; ownership has no privileges here so
      // we pin everyone to "member".
      await createRoomMembership(ctx, room._id, ownerId, 'member')
    }

    return room
  },
})

export const getRoom = query({
  args: { roomId: v.id('social_rooms') },
  returns: optionalRoomSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    const membership = await ctx.db
      .query('social_room_members')
      .withIndex('by_roomId_and_ownerId', (q) =>
        q.eq('roomId', args.roomId).eq('ownerId', ownerId),
      )
      .unique()
    if (!membership) {
      return null
    }
    const room = await ctx.db.get(args.roomId)
    return await hydrateRoomSummary(ctx, room, membership)
  },
})

export const getOrCreateDmRoom = mutation({
  args: {
    otherOwnerId: v.string(),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_get_or_create_dm_room',
      ownerId,
      RATE_STANDARD,
      'Too many room requests. Please slow down and try again.',
    )
    await ensureSocialProfileDoc(ctx, ownerId)
    await ensureSocialProfileDoc(ctx, args.otherOwnerId)
    if (ownerId === args.otherOwnerId) {
      throw new ConvexError({
        code: 'INVALID_ARGUMENT',
        message: 'Cannot create a DM with yourself',
      })
    }
    const relationship = await loadRelationship(ctx, ownerId, args.otherOwnerId)
    ensureRelationshipIsAccepted(relationship)

    const roomKey = `dm:${getRelationshipKey(ownerId, args.otherOwnerId)}`
    const existing = await ctx.db
      .query('social_rooms')
      .withIndex('by_roomKey', (q) => q.eq('roomKey', roomKey))
      .unique()
    if (existing) {
      return existing
    }

    const now = Date.now()
    const roomId = await ctx.db.insert('social_rooms', {
      kind: 'dm',
      roomKey,
      createdByOwnerId: ownerId,
      createdAt: now,
      updatedAt: now,
      latestMessageAt: now,
    })
    await Promise.all([
      createRoomMembership(ctx, roomId, ownerId, 'owner'),
      createRoomMembership(ctx, roomId, args.otherOwnerId, 'member'),
    ])
    const room = await ctx.db.get(roomId)
    if (!room) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create DM room',
      })
    }
    return room
  },
})

export const createGroupRoom = mutation({
  args: {
    title: v.string(),
    memberOwnerIds: v.array(v.string()),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    // Each call writes N membership rows; cap so we can't be used to spawn
    // unbounded room/membership churn.
    await enforceMutationRateLimit(
      ctx,
      'social_create_group_room',
      ownerId,
      RATE_VERY_EXPENSIVE,
      'Too many group rooms created. Please wait a minute and try again.',
    )
    const title = args.title.trim()
    if (!title) {
      throw new ConvexError({
        code: 'INVALID_ARGUMENT',
        message: 'title is required',
      })
    }
    requireBoundedString(title, 'title', 120)

    const uniqueMemberOwnerIds = [
      ...new Set(
        args.memberOwnerIds.filter((value) => value && value !== ownerId),
      ),
    ]
    const acceptedRelationships = await listAcceptedRelationshipsForOwner(
      ctx,
      ownerId,
    )
    const acceptedOwnerIds = new Set(
      acceptedRelationships.map((relationship) =>
        relationship.lowOwnerId === ownerId
          ? relationship.highOwnerId
          : relationship.lowOwnerId,
      ),
    )

    for (const memberOwnerId of uniqueMemberOwnerIds) {
      if (!acceptedOwnerIds.has(memberOwnerId)) {
        throw new ConvexError({
          code: 'FORBIDDEN',
          message: 'Only friends can be invited to a group',
        })
      }
      await ensureSocialProfileDoc(ctx, memberOwnerId)
    }

    const now = Date.now()
    const roomId = await ctx.db.insert('social_rooms', {
      kind: 'group',
      title,
      createdByOwnerId: ownerId,
      createdAt: now,
      updatedAt: now,
      latestMessageAt: now,
    })

    await createRoomMembership(ctx, roomId, ownerId, 'owner')
    await Promise.all(
      uniqueMemberOwnerIds.map(async (memberOwnerId) => {
        await createRoomMembership(ctx, roomId, memberOwnerId, 'member')
      }),
    )

    const room = await ctx.db.get(roomId)
    if (!room) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create group room',
      })
    }
    return room
  },
})

export const addGroupMembers = mutation({
  args: {
    roomId: v.id('social_rooms'),
    memberOwnerIds: v.array(v.string()),
  },
  returns: socialRoomValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    await enforceMutationRateLimit(
      ctx,
      'social_add_group_members',
      ownerId,
      RATE_STANDARD,
      'Too many group membership changes. Please slow down and try again.',
    )
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId)
    assertRoomOwnerRole(membership)
    const room = await ctx.db.get(args.roomId)
    if (!room || room.kind !== 'group') {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Group room not found',
      })
    }

    const acceptedRelationships = await listAcceptedRelationshipsForOwner(
      ctx,
      ownerId,
    )
    const acceptedOwnerIds = new Set(
      acceptedRelationships.map((relationship) =>
        relationship.lowOwnerId === ownerId
          ? relationship.highOwnerId
          : relationship.lowOwnerId,
      ),
    )

    for (const memberOwnerId of [...new Set(args.memberOwnerIds)]) {
      if (memberOwnerId === ownerId) {
        continue
      }
      if (!acceptedOwnerIds.has(memberOwnerId)) {
        throw new ConvexError({
          code: 'FORBIDDEN',
          message: 'Only friends can be invited to a group',
        })
      }
      const existing = await ctx.db
        .query('social_room_members')
        .withIndex('by_roomId_and_ownerId', (q) =>
          q.eq('roomId', args.roomId).eq('ownerId', memberOwnerId),
        )
        .unique()
      if (!existing) {
        await createRoomMembership(ctx, args.roomId, memberOwnerId, 'member')
        await attachMemberToActiveSession(ctx, args.roomId, memberOwnerId)
      }
    }

    await ctx.db.patch(args.roomId, {
      updatedAt: Date.now(),
    })
    const updated = await ctx.db.get(args.roomId)
    if (!updated) {
      throw new ConvexError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to update room',
      })
    }
    return updated
  },
})

export const markRoomRead = mutation({
  args: {
    roomId: v.id('social_rooms'),
    messageId: v.optional(v.id('social_messages')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx)
    // Hot path (called on every focus / scroll), so use the loose hot-path
    // budget — but still cap it so it can't be looped at runtime to churn
    // the membership row.
    await enforceMutationRateLimit(
      ctx,
      'social_mark_room_read',
      ownerId,
      RATE_HOT_PATH,
    )
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId)
    await ctx.db.patch(membership._id, {
      ...(args.messageId ? { lastReadMessageId: args.messageId } : {}),
      lastReadAt: Date.now(),
      updatedAt: Date.now(),
    })
    return null
  },
})
