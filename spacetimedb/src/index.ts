import { ScheduleAt, type Identity, type ScheduleAt as ScheduleAtValue } from "spacetimedb";
import { SenderError, schema, t, table, type ReducerCtx } from "spacetimedb/server";
import nacl from "tweetnacl";

const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const EMPTY_JSON_OBJECT = "{}";
const MAX_CHAT_MESSAGE_LENGTH = 500;
const FREEFORM_TURN_SLOT = 0;
const TICK_INTERVAL_MIN_MS = 100;
const TICK_INTERVAL_MAX_MS = 60_000;
const GAME_AUTH_ISSUER = "stella-game";
const GAME_AUTH_AUDIENCE = "stella-hosted-game";
const GAME_AUTH_VERSION = 1;
const GAME_REGISTRATION_TTL_MS = 24n * 60n * 60n * 1000n;
const GAME_AUTH_PUBLIC_KEY_BASE64URL = "HQU9NBm0-pzP56UJ-VUX4VNxcR25YxwFp21yy0WlLiY";

const gameSessions = table(
  { name: "game_sessions", public: true },
  {
    session_id: t.u64().primaryKey().autoInc(),
    game_id: t.string().index(),
    join_code: t.string().unique(),
    host_identity: t.identity(),
    host_convex_id: t.string(),
    game_type: t.string().index(),
    status: t.string().index(),
    config_json: t.string(),
    state_json: t.string(),
    current_turn_player_slot: t.u32(),
    turn_number: t.u32(),
    max_players: t.u32(),
    created_at: t.u64(),
    updated_at: t.u64(),
    started_at: t.u64(),
    ended_at: t.u64(),
  },
);

const gamePlayers = table(
  {
    name: "game_players",
    public: true,
    indexes: [
      { name: "session_slot", algorithm: "btree", columns: ["session_id", "slot"] },
      {
        name: "session_identity",
        algorithm: "btree",
        columns: ["session_id", "player_identity"],
      },
      {
        name: "session_convex_user",
        algorithm: "btree",
        columns: ["session_id", "convex_user_id"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_identity: t.identity().index(),
    convex_user_id: t.string().index(),
    display_name: t.string(),
    avatar_url: t.string(),
    slot: t.u32(),
    score: t.i64(),
    status: t.string(),
    is_host: t.u8(),
    metadata_json: t.string(),
    joined_at: t.u64(),
    last_seen_at: t.u64(),
  },
);

const playerPrivateState = table(
  {
    name: "player_private_state",
    public: false,
    indexes: [
      {
        name: "session_identity",
        algorithm: "btree",
        columns: ["session_id", "player_identity"],
      },
      {
        name: "session_identity_state_key",
        algorithm: "btree",
        columns: ["session_id", "player_identity", "state_key"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_identity: t.identity().index(),
    state_key: t.string(),
    state_value: t.string(),
    updated_at: t.u64(),
  },
);

const gameObjects = table(
  {
    name: "game_objects",
    public: true,
    indexes: [
      {
        name: "session_object_type",
        algorithm: "btree",
        columns: ["session_id", "object_type"],
      },
      {
        name: "session_object_key",
        algorithm: "btree",
        columns: ["session_id", "object_key"],
      },
      {
        name: "session_owner_slot",
        algorithm: "btree",
        columns: ["session_id", "owner_slot"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    object_type: t.string().index(),
    object_key: t.string(),
    owner_slot: t.i32(),
    position_json: t.string(),
    state_json: t.string(),
    sort_order: t.u32(),
    created_at: t.u64(),
    updated_at: t.u64(),
  },
);

const gameActions = table(
  {
    name: "game_actions",
    public: true,
    indexes: [
      {
        name: "session_turn",
        algorithm: "btree",
        columns: ["session_id", "turn_number"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_slot: t.u32(),
    turn_number: t.u32(),
    action_type: t.string().index(),
    payload_json: t.string(),
    result_json: t.string(),
    timestamp: t.u64(),
  },
);

const gameChat = table(
  { name: "game_chat", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_slot: t.u32(),
    display_name: t.string(),
    message: t.string(),
    message_type: t.string(),
    timestamp: t.u64(),
  },
);

const gameTickSchedule = table(
  { name: "game_tick_schedule" },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    session_id: t.u64().index(),
  },
);

const identityMap = table(
  { name: "identity_map" },
  {
    id: t.u64().primaryKey().autoInc(),
    stdb_identity: t.identity().unique(),
    game_id: t.string().index(),
    convex_user_id: t.string().index(),
    display_name: t.string(),
    expires_at: t.u64(),
    registered_at: t.u64(),
  },
);

const usedGameTokens = table(
  { name: "used_game_tokens" },
  {
    id: t.u64().primaryKey().autoInc(),
    jti: t.string().unique(),
    stdb_identity: t.identity().index(),
    game_id: t.string().index(),
    used_at: t.u64(),
  },
);

const spacetime = schema(
  gameSessions,
  gamePlayers,
  playerPrivateState,
  gameObjects,
  gameActions,
  gameChat,
  gameTickSchedule,
  identityMap,
  usedGameTokens,
);

type StellaDb = ReducerCtx<typeof spacetime.schemaType>["db"];
type GameSessionRow = ReturnType<StellaDb["gameSessions"]["session_id"]["find"]> extends infer T ? Exclude<T, null> : never;
type GamePlayerRow = ReturnType<StellaDb["gamePlayers"]["id"]["find"]> extends infer T ? Exclude<T, null> : never;
type PrivateStateRow = ReturnType<StellaDb["playerPrivateState"]["id"]["find"]> extends infer T ? Exclude<T, null> : never;
type GameObjectRow = ReturnType<StellaDb["gameObjects"]["id"]["find"]> extends infer T ? Exclude<T, null> : never;
type IdentityMapRow = ReturnType<StellaDb["identityMap"]["stdb_identity"]["find"]> extends infer T ? Exclude<T, null> : never;
type UsedGameTokenRow = ReturnType<StellaDb["usedGameTokens"]["jti"]["find"]> extends infer T ? Exclude<T, null> : never;

const privateStateViewRow = t.row("MyPrivateStateRow", {
  id: t.u64(),
  session_id: t.u64(),
  player_identity: t.identity(),
  state_key: t.string(),
  state_value: t.string(),
  updated_at: t.u64(),
});

spacetime.view(
  { name: "my_private_state", public: true },
  t.array(privateStateViewRow),
  (ctx) =>
    ctx.from.player_private_state
      .where((row) => row.player_identity.eq(ctx.sender))
      .build(),
);

function fail(message: string): never {
  throw new SenderError(message);
}

function nowMicros(ctx: ReducerCtx<typeof spacetime.schemaType>): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeJoinCode(joinCode: string): string {
  return joinCode.trim().toUpperCase();
}

function parseJsonRecord(json: string, fieldName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${fieldName} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    fail(`${fieldName} is invalid JSON: ${message}`);
  }
}

function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function findFirst<T>(rows: Iterable<T>): T | null {
  for (const row of rows) {
    return row;
  }
  return null;
}

function collectRows<T>(rows: Iterable<T>): T[] {
  return Array.from(rows);
}

type GameAuthPayload = {
  v: number;
  iss: string;
  aud: string;
  sub: string;
  gameId: string;
  joinCode: string;
  spacetimeSessionId?: string;
  displayName: string;
  isAnonymous: boolean;
  iat: number;
  exp: number;
  jti: string;
};

function nowMillis(ctx: ReducerCtx<typeof spacetime.schemaType>): bigint {
  return nowMicros(ctx) / 1000n;
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded =
    remainder === 0
      ? normalized
      : remainder === 2
        ? `${normalized}==`
        : remainder === 3
          ? `${normalized}=`
          : fail("Invalid token encoding.");

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of padded) {
    if (char === "=") break;
    const index = alphabet.indexOf(char);
    if (index < 0) {
      fail("Invalid token encoding.");
    }
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

function parseGameAuthPayload(rawPayload: Record<string, unknown>): GameAuthPayload {
  const version = typeof rawPayload.v === "number" ? rawPayload.v : null;
  const issuer = toOptionalString(rawPayload.iss);
  const audience = toOptionalString(rawPayload.aud);
  const subject = toOptionalString(rawPayload.sub);
  const gameId = toOptionalString(rawPayload.gameId);
  const joinCode = toOptionalString(rawPayload.joinCode);
  const displayName = toOptionalString(rawPayload.displayName);
  const tokenId = toOptionalString(rawPayload.jti);
  const issuedAt = typeof rawPayload.iat === "number" ? rawPayload.iat : null;
  const expiresAt = typeof rawPayload.exp === "number" ? rawPayload.exp : null;
  const spacetimeSessionId = toOptionalString(rawPayload.spacetimeSessionId) ?? undefined;

  if (version !== GAME_AUTH_VERSION) {
    fail("Unsupported game launch token version.");
  }
  if (issuer !== GAME_AUTH_ISSUER || audience !== GAME_AUTH_AUDIENCE) {
    fail("Invalid game launch token issuer.");
  }
  if (!subject || !gameId || !joinCode || !displayName || !tokenId) {
    fail("Game launch token is missing required claims.");
  }
  if (rawPayload.isAnonymous !== false) {
    fail("Anonymous launch tokens are not allowed.");
  }
  if (issuedAt === null || expiresAt === null || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    fail("Game launch token timestamps are invalid.");
  }

  return {
    v: version,
    iss: issuer,
    aud: audience,
    sub: subject,
    gameId,
    joinCode,
    ...(spacetimeSessionId ? { spacetimeSessionId } : {}),
    displayName,
    isAnonymous: false,
    iat: issuedAt,
    exp: expiresAt,
    jti: tokenId,
  };
}

function verifyGameLaunchToken(token: string, ctx: ReducerCtx<typeof spacetime.schemaType>): GameAuthPayload {
  const parts = token.split(".");
  if (parts.length !== 2) {
    fail("game_token is not valid.");
  }

  const payloadBytes = base64UrlDecodeToBytes(parts[0]);
  const signatureBytes = base64UrlDecodeToBytes(parts[1]);
  const publicKey = base64UrlDecodeToBytes(GAME_AUTH_PUBLIC_KEY_BASE64URL);
  if (!nacl.sign.detached.verify(payloadBytes, signatureBytes, publicKey)) {
    fail("game_token signature is invalid.");
  }

  const payloadRecord = parseJsonRecord(
    new TextDecoder().decode(payloadBytes),
    "game_token",
  );
  const payload = parseGameAuthPayload(payloadRecord);
  if (BigInt(payload.exp) < nowMillis(ctx)) {
    fail("Game launch token has expired.");
  }
  return payload;
}

function getIdentityRegistration(ctx: ReducerCtx<typeof spacetime.schemaType>): IdentityMapRow | null {
  return ctx.db.identityMap.stdb_identity.find(ctx.sender);
}

function requireIdentityRegistration(ctx: ReducerCtx<typeof spacetime.schemaType>): IdentityMapRow {
  const registration = getIdentityRegistration(ctx) ?? fail("Register this player first.");
  if (registration.expires_at < nowMillis(ctx)) {
    ctx.db.identityMap.stdb_identity.delete(ctx.sender);
    fail("Game access expired. Reopen this game from Stella.");
  }
  return registration;
}

function requireRegistrationForGame(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  gameId: string,
): IdentityMapRow {
  const registration = requireIdentityRegistration(ctx);
  if (registration.game_id !== gameId) {
    fail("This game launch is not valid for the current game.");
  }
  return registration;
}

function getSession(ctx: ReducerCtx<typeof spacetime.schemaType>, sessionId: bigint): GameSessionRow {
  return ctx.db.gameSessions.session_id.find(sessionId) ?? fail("Game session not found.");
}

function getSessionByJoinCode(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  joinCode: string,
): GameSessionRow {
  return ctx.db.gameSessions.join_code.find(normalizeJoinCode(joinCode)) ?? fail("Join code not found.");
}

function getPlayersForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): GamePlayerRow[] {
  return collectRows(ctx.db.gamePlayers.session_slot.filter(sessionId));
}

function getPlayerByIdentity(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  playerIdentity: Identity,
): GamePlayerRow | null {
  return findFirst(ctx.db.gamePlayers.session_identity.filter([sessionId, playerIdentity]));
}

function getRequiredPlayerByIdentity(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  playerIdentity: Identity,
): GamePlayerRow {
  return getPlayerByIdentity(ctx, sessionId, playerIdentity) ?? fail("You are not part of this session.");
}

function getPlayerBySlot(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  slot: number,
): GamePlayerRow | null {
  return findFirst(ctx.db.gamePlayers.session_slot.filter([sessionId, slot]));
}

function getRequiredPlayerBySlot(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  slot: number,
): GamePlayerRow {
  return getPlayerBySlot(ctx, sessionId, slot) ?? fail("Player slot not found.");
}

function requireHostPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: GameSessionRow,
): GamePlayerRow {
  requireRegistrationForGame(ctx, session.game_id);
  const player = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);
  if (player.is_host !== 1) {
    fail("Only the host can do that.");
  }
  return player;
}

function requireHostOrTurnPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: GameSessionRow,
): GamePlayerRow {
  requireRegistrationForGame(ctx, session.game_id);
  const player = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);
  if (player.is_host === 1) {
    return player;
  }
  if (session.current_turn_player_slot !== FREEFORM_TURN_SLOT && player.slot === session.current_turn_player_slot) {
    return player;
  }
  fail("Only the host or current turn player can do that.");
}

function countActivePlayers(players: readonly GamePlayerRow[]): number {
  return players.filter(
    (player) => player.status !== "spectating" && player.status !== "eliminated",
  ).length;
}

function getNextOpenSlot(players: readonly GamePlayerRow[]): number {
  let maxSlot = -1;
  for (const player of players) {
    if (player.slot > maxSlot) {
      maxSlot = player.slot;
    }
  }
  return maxSlot + 1;
}

function rotateTurnSlot(players: readonly GamePlayerRow[], currentSlot: number): number {
  const turnEligible = players
    .filter(
      (player) =>
        player.slot > FREEFORM_TURN_SLOT &&
        player.status !== "spectating" &&
        player.status !== "eliminated" &&
        player.status !== "disconnected",
    )
    .sort((left, right) => left.slot - right.slot);

  if (turnEligible.length === 0) {
    return FREEFORM_TURN_SLOT;
  }

  const currentIndex = turnEligible.findIndex((player) => player.slot === currentSlot);
  if (currentIndex < 0) {
    return turnEligible[0].slot;
  }
  return turnEligible[(currentIndex + 1) % turnEligible.length].slot;
}

function deletePrivateStateForPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  playerIdentity: Identity,
): void {
  for (const row of ctx.db.playerPrivateState.session_identity.filter([sessionId, playerIdentity])) {
    ctx.db.playerPrivateState.id.delete(row.id);
  }
}

function deleteTickSchedulesForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): void {
  for (const row of ctx.db.gameTickSchedule.session_id.filter(sessionId)) {
    ctx.db.gameTickSchedule.scheduled_id.delete(row.scheduled_id);
  }
}

function getTickScheduleForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
) {
  return findFirst(ctx.db.gameTickSchedule.session_id.filter(sessionId));
}

function compactLobbySlots(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): GamePlayerRow[] {
  const players = getPlayersForSession(ctx, sessionId).sort((left, right) => left.slot - right.slot);
  const compacted: GamePlayerRow[] = [];

  for (let index = 0; index < players.length; index += 1) {
    const next = { ...players[index], slot: index, is_host: 0 };
    const updated = ctx.db.gamePlayers.id.update(next);
    compacted.push(updated);
  }

  return compacted;
}

function promoteLobbyHost(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: GameSessionRow,
): GameSessionRow {
  const players = compactLobbySlots(ctx, session.session_id);
  if (players.length === 0) {
    return ctx.db.gameSessions.session_id.update({
      ...session,
      status: "abandoned",
      updated_at: nowMicros(ctx),
      ended_at: nowMicros(ctx),
    });
  }

  const promoted = players[0];
  ctx.db.gamePlayers.id.update({ ...promoted, is_host: 1 });

  return ctx.db.gameSessions.session_id.update({
    ...session,
    host_identity: promoted.player_identity,
    host_convex_id: promoted.convex_user_id,
    updated_at: nowMicros(ctx),
  });
}

function validateSessionStatus(
  session: GameSessionRow,
  expectedStatuses: readonly string[],
): void {
  if (!expectedStatuses.includes(session.status)) {
    fail(`Session must be ${expectedStatuses.join(" or ")}.`);
  }
}

function generateJoinCode(ctx: ReducerCtx<typeof spacetime.schemaType>): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let code = "";
    for (let index = 0; index < 4; index += 1) {
      const randomIndex = ctx.random.integerInRange(0, JOIN_CODE_ALPHABET.length - 1);
      code += JOIN_CODE_ALPHABET[randomIndex];
    }
    if (ctx.db.gameSessions.join_code.find(code) === null) {
      return code;
    }
  }
  fail("Unable to generate a unique join code. Please try again.");
}

function logGameAction(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  playerSlot: number,
  turnNumber: number,
  actionType: string,
  payloadJson: string,
  resultJson: string,
): void {
  ctx.db.gameActions.insert({
    id: 0n,
    session_id: sessionId,
    player_slot: playerSlot,
    turn_number: turnNumber,
    action_type: actionType,
    payload_json: payloadJson,
    result_json: resultJson,
    timestamp: nowMicros(ctx),
  });
}

spacetime.reducer(
  "register_player",
  {
    game_token: t.string(),
  },
  (ctx, { game_token }) => {
    const payload = verifyGameLaunchToken(game_token, ctx);
    const existingTokenUse: UsedGameTokenRow | null = ctx.db.usedGameTokens.jti.find(payload.jti);
    if (existingTokenUse) {
      fail("This game launch token has already been used.");
    }

    const current = ctx.db.identityMap.stdb_identity.find(ctx.sender);
    const registeredAt = nowMicros(ctx);
    const expiresAt = nowMillis(ctx) + GAME_REGISTRATION_TTL_MS;

    ctx.db.usedGameTokens.insert({
      id: 0n,
      jti: payload.jti,
      stdb_identity: ctx.sender,
      game_id: payload.gameId,
      used_at: registeredAt,
    });

    if (current) {
      ctx.db.identityMap.stdb_identity.update({
        ...current,
        game_id: payload.gameId,
        convex_user_id: payload.sub,
        display_name: payload.displayName,
        expires_at: expiresAt,
        registered_at: registeredAt,
      });
      return;
    }

    ctx.db.identityMap.insert({
      id: 0n,
      stdb_identity: ctx.sender,
      game_id: payload.gameId,
      convex_user_id: payload.sub,
      display_name: payload.displayName,
      expires_at: expiresAt,
      registered_at: registeredAt,
    });
  },
);

spacetime.reducer(
  "create_session",
  {
    game_type: t.string(),
    config_json: t.string(),
    max_players: t.u32(),
  },
  (ctx, { game_type, config_json, max_players }) => {
    const registration = requireIdentityRegistration(ctx);
    const trimmedGameType = game_type.trim();
    if (!trimmedGameType) {
      fail("game_type is required.");
    }
    if (max_players < 2) {
      fail("max_players must be at least 2.");
    }

    parseJsonRecord(config_json, "config_json");

    const createdAt = nowMicros(ctx);
    const session = ctx.db.gameSessions.insert({
      session_id: 0n,
      game_id: registration.game_id,
      join_code: generateJoinCode(ctx),
      host_identity: ctx.sender,
      host_convex_id: registration.convex_user_id,
      game_type: trimmedGameType,
      status: "lobby",
      config_json,
      state_json: EMPTY_JSON_OBJECT,
      current_turn_player_slot: FREEFORM_TURN_SLOT,
      turn_number: 0,
      max_players,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: 0n,
      ended_at: 0n,
    });

    ctx.db.gamePlayers.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: ctx.sender,
      convex_user_id: registration.convex_user_id,
      display_name: registration.display_name,
      avatar_url: "",
      slot: 0,
      score: 0n,
      status: "connected",
      is_host: 1,
      metadata_json: EMPTY_JSON_OBJECT,
      joined_at: createdAt,
      last_seen_at: createdAt,
    });
  },
);

spacetime.reducer(
  "join_session",
  {
    join_code: t.string(),
  },
  (ctx, { join_code }) => {
    const registration = requireIdentityRegistration(ctx);
    const session = getSessionByJoinCode(ctx, join_code);
    if (session.game_id !== registration.game_id) {
      fail("This launch token cannot join that session.");
    }
    validateSessionStatus(session, ["lobby"]);

    const players = getPlayersForSession(ctx, session.session_id);
    if (players.length >= session.max_players) {
      fail("This session is full.");
    }
    if (getPlayerByIdentity(ctx, session.session_id, ctx.sender)) {
      fail("You have already joined this session.");
    }

    ctx.db.gamePlayers.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: ctx.sender,
      convex_user_id: registration.convex_user_id,
      display_name: registration.display_name,
      avatar_url: "",
      slot: getNextOpenSlot(players),
      score: 0n,
      status: "connected",
      is_host: 0,
      metadata_json: EMPTY_JSON_OBJECT,
      joined_at: nowMicros(ctx),
      last_seen_at: nowMicros(ctx),
    });

    ctx.db.gameSessions.session_id.update({
      ...session,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "leave_session",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireRegistrationForGame(ctx, session.game_id);
    const player = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);

    if (session.status === "lobby") {
      deletePrivateStateForPlayer(ctx, session.session_id, player.player_identity);
      ctx.db.gamePlayers.id.delete(player.id);
      if (player.is_host === 1) {
        promoteLobbyHost(ctx, session);
      } else {
        compactLobbySlots(ctx, session.session_id);
        ctx.db.gameSessions.session_id.update({
          ...session,
          updated_at: nowMicros(ctx),
        });
      }
      return;
    }

    ctx.db.gamePlayers.id.update({
      ...player,
      status: "disconnected",
      last_seen_at: nowMicros(ctx),
    });

    ctx.db.gameSessions.session_id.update({
      ...session,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "start_game",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateSessionStatus(session, ["lobby"]);

    const players = getPlayersForSession(ctx, session.session_id);
    if (countActivePlayers(players) < 2) {
      fail("At least two players are required to start.");
    }

    ctx.db.gameSessions.session_id.update({
      ...session,
      status: "active",
      turn_number: 1,
      started_at: nowMicros(ctx),
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "end_game",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);

    deleteTickSchedulesForSession(ctx, session.session_id);
    const endedAt = nowMicros(ctx);
    const updated = ctx.db.gameSessions.session_id.update({
      ...session,
      status: "finished",
      ended_at: endedAt,
      updated_at: endedAt,
    });

    logGameAction(
      ctx,
      updated.session_id,
      FREEFORM_TURN_SLOT,
      updated.turn_number,
      "game_ended",
      EMPTY_JSON_OBJECT,
      EMPTY_JSON_OBJECT,
    );
  },
);

spacetime.reducer(
  "pause_game",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);

    if (session.status !== "active" && session.status !== "paused") {
      fail("Only active or paused sessions can be toggled.");
    }

    ctx.db.gameSessions.session_id.update({
      ...session,
      status: session.status === "active" ? "paused" : "active",
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "submit_action",
  {
    session_id: t.u64(),
    action_type: t.string(),
    payload_json: t.string(),
    result_json: t.string(),
  },
  (ctx, { session_id, action_type, payload_json, result_json }) => {
    const session = getSession(ctx, session_id);
    requireRegistrationForGame(ctx, session.game_id);
    validateSessionStatus(session, ["active"]);
    const player = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);

    if (session.current_turn_player_slot !== FREEFORM_TURN_SLOT && player.slot !== session.current_turn_player_slot) {
      fail("It is not your turn.");
    }

    parseJsonRecord(payload_json, "payload_json");
    parseJsonRecord(result_json, "result_json");

    logGameAction(
      ctx,
      session.session_id,
      player.slot,
      session.turn_number,
      action_type.trim() || fail("action_type is required."),
      payload_json,
      result_json,
    );

    if (session.current_turn_player_slot === FREEFORM_TURN_SLOT) {
      ctx.db.gameSessions.session_id.update({
        ...session,
        updated_at: nowMicros(ctx),
      });
      return;
    }

    const players = getPlayersForSession(ctx, session.session_id);
    ctx.db.gameSessions.session_id.update({
      ...session,
      current_turn_player_slot: rotateTurnSlot(players, session.current_turn_player_slot),
      turn_number: session.turn_number + 1,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "update_session_state",
  {
    session_id: t.u64(),
    expected_turn_number: t.u32(),
    state_json: t.string(),
    current_turn_player_slot: t.u32(),
    turn_number: t.u32(),
  },
  (ctx, { session_id, expected_turn_number, state_json, current_turn_player_slot, turn_number }) => {
    const session = getSession(ctx, session_id);
    requireHostOrTurnPlayer(ctx, session);
    if (session.turn_number !== expected_turn_number) {
      fail("Session state is stale. Refresh and try again.");
    }

    parseJsonRecord(state_json, "state_json");

    ctx.db.gameSessions.session_id.update({
      ...session,
      state_json,
      current_turn_player_slot,
      turn_number,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "create_object",
  {
    session_id: t.u64(),
    object_type: t.string(),
    object_key: t.string(),
    owner_slot: t.i32(),
    position_json: t.string(),
    state_json: t.string(),
    sort_order: t.u32(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    requireHostOrTurnPlayer(ctx, session);

    parseJsonRecord(args.position_json, "position_json");
    parseJsonRecord(args.state_json, "state_json");

    ctx.db.gameObjects.insert({
      id: 0n,
      session_id: args.session_id,
      object_type: args.object_type.trim() || fail("object_type is required."),
      object_key: args.object_key.trim() || fail("object_key is required."),
      owner_slot: args.owner_slot,
      position_json: args.position_json,
      state_json: args.state_json,
      sort_order: args.sort_order,
      created_at: nowMicros(ctx),
      updated_at: nowMicros(ctx),
    });
  },
);

function canUpdateObject(player: GamePlayerRow, object: GameObjectRow): boolean {
  return player.is_host === 1 || object.owner_slot === player.slot;
}

spacetime.reducer(
  "update_object",
  {
    id: t.u64(),
    owner_slot: t.i32(),
    position_json: t.string(),
    state_json: t.string(),
    sort_order: t.u32(),
  },
  (ctx, { id, owner_slot, position_json, state_json, sort_order }) => {
    const object = ctx.db.gameObjects.id.find(id) ?? fail("Object not found.");
    const session = getSession(ctx, object.session_id);
    const player = requireHostOrTurnPlayer(ctx, session);
    if (!canUpdateObject(player, object) && session.current_turn_player_slot !== player.slot) {
      fail("You do not have permission to update this object.");
    }

    parseJsonRecord(position_json, "position_json");
    parseJsonRecord(state_json, "state_json");

    ctx.db.gameObjects.id.update({
      ...object,
      owner_slot,
      position_json,
      state_json,
      sort_order,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "remove_object",
  {
    id: t.u64(),
  },
  (ctx, { id }) => {
    const object = ctx.db.gameObjects.id.find(id) ?? fail("Object not found.");
    const session = getSession(ctx, object.session_id);
    const player = requireHostOrTurnPlayer(ctx, session);
    if (!canUpdateObject(player, object) && session.current_turn_player_slot !== player.slot) {
      fail("You do not have permission to remove this object.");
    }
    ctx.db.gameObjects.id.delete(object.id);
  },
);

spacetime.reducer(
  "update_player_score",
  {
    session_id: t.u64(),
    target_player_slot: t.u32(),
    score_delta: t.i64(),
  },
  (ctx, { session_id, target_player_slot, score_delta }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const player = getRequiredPlayerBySlot(ctx, session.session_id, target_player_slot);
    ctx.db.gamePlayers.id.update({
      ...player,
      score: player.score + score_delta,
      last_seen_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "update_player_private_state",
  {
    session_id: t.u64(),
    target_player_slot: t.u32(),
    state_key: t.string(),
    state_value: t.string(),
  },
  (ctx, { session_id, target_player_slot, state_key, state_value }) => {
    const session = getSession(ctx, session_id);
    requireRegistrationForGame(ctx, session.game_id);
    const caller = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);
    const targetPlayer = getRequiredPlayerBySlot(ctx, session.session_id, target_player_slot);
    const trimmedKey = state_key.trim();
    if (!trimmedKey) {
      fail("state_key is required.");
    }

    if (caller.is_host !== 1 && caller.id !== targetPlayer.id) {
      fail("You can only update your own private state.");
    }

    const existing = findFirst(
      ctx.db.playerPrivateState.session_identity_state_key.filter([
        session.session_id,
        targetPlayer.player_identity,
        trimmedKey,
      ]),
    );

    if (existing) {
      ctx.db.playerPrivateState.id.update({
        ...existing,
        state_value,
        updated_at: nowMicros(ctx),
      });
      return;
    }

    ctx.db.playerPrivateState.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: targetPlayer.player_identity,
      state_key: trimmedKey,
      state_value,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "send_chat",
  {
    session_id: t.u64(),
    message: t.string(),
    message_type: t.string(),
  },
  (ctx, { session_id, message, message_type }) => {
    const session = getSession(ctx, session_id);
    requireRegistrationForGame(ctx, session.game_id);
    const player = getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      fail("message is required.");
    }

    ctx.db.gameChat.insert({
      id: 0n,
      session_id: session.session_id,
      player_slot: player.slot,
      display_name: player.display_name,
      message: trimmedMessage.slice(0, MAX_CHAT_MESSAGE_LENGTH),
      message_type: message_type.trim() || "text",
      timestamp: nowMicros(ctx),
    });
  },
);

function getTickIntervalMs(scheduleAt: ScheduleAtValue): number {
  if (scheduleAt.tag === "Interval") {
    return scheduleAt.value.millis;
  }
  return 0;
}

spacetime.reducer(
  "game_tick",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const schedule = getTickScheduleForSession(ctx, session_id);
    if (!schedule) {
      fail("No active tick timer for this session.");
    }

    if (session.status !== "active") {
      deleteTickSchedulesForSession(ctx, session_id);
      return;
    }

    const state = parseJsonRecord(session.state_json, "state_json");
    const currentTimer = typeof state.turnTimerMs === "number" && Number.isFinite(state.turnTimerMs)
      ? Math.max(0, Math.floor(state.turnTimerMs))
      : null;
    if (currentTimer === null) {
      return;
    }

    const nextTimer = Math.max(0, currentTimer - getTickIntervalMs(schedule.scheduled_at));
    state.turnTimerMs = nextTimer;

    let nextTurnNumber = session.turn_number;
    let nextTurnSlot = session.current_turn_player_slot;

    if (nextTimer === 0 && session.current_turn_player_slot !== FREEFORM_TURN_SLOT) {
      const players = getPlayersForSession(ctx, session.session_id);
      nextTurnSlot = rotateTurnSlot(players, session.current_turn_player_slot);
      nextTurnNumber += 1;
    }

    ctx.db.gameSessions.session_id.update({
      ...session,
      state_json: stringifyJson(state),
      current_turn_player_slot: nextTurnSlot,
      turn_number: nextTurnNumber,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "start_tick_timer",
  {
    session_id: t.u64(),
    interval_ms: t.u32(),
  },
  (ctx, { session_id, interval_ms }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    if (interval_ms < TICK_INTERVAL_MIN_MS || interval_ms > TICK_INTERVAL_MAX_MS) {
      fail("interval_ms must be between 100 and 60000.");
    }

    deleteTickSchedulesForSession(ctx, session.session_id);
    ctx.db.gameTickSchedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(BigInt(interval_ms) * 1000n),
      session_id: session.session_id,
    });
  },
);

spacetime.reducer(
  "stop_tick_timer",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    deleteTickSchedulesForSession(ctx, session.session_id);
  },
);
