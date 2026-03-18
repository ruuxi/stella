import { ScheduleAt, type Identity, type ScheduleAt as ScheduleAtValue } from "spacetimedb";
import { SenderError, schema, t, table, type ReducerCtx } from "spacetimedb/server";
import nacl from "tweetnacl";

const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const EMPTY_JSON_OBJECT = "{}";
const DEFAULT_RUNTIME_KIND = "authoritative";
const DEFAULT_RULESET_KEY = "default";
const DEFAULT_INTEREST_MODE = "session";
const DEFAULT_PHASE_KEY = "lobby";
const DEFAULT_VISIBILITY_SCOPE = "public";
const DEFAULT_REPLICATION_GROUP = "default";
const DEFAULT_ZONE_KEY = "global";
const DEFAULT_RESOURCE_SCOPE = "session";
const DEFAULT_ENTITY_AUTHORITY = "host";
const DEFAULT_INPUT_KIND = "frame";
const DEFAULT_EVENT_SCOPE = "session";
const DEFAULT_LIFECYCLE_CONNECTED = "connected";
const DEFAULT_LIFECYCLE_LOBBY = "lobby";
const DEFAULT_LIFECYCLE_RUNNING = "running";
const DEFAULT_LIFECYCLE_PAUSED = "paused";
const DEFAULT_LIFECYCLE_ENDED = "ended";
const DEFAULT_LIFECYCLE_ABANDONED = "abandoned";
const DEFAULT_TICK_RATE_HZ = 20;
const DEFAULT_SNAPSHOT_RATE_HZ = 20;
const DEFAULT_PARTITION_SIZE = 32;
const NO_ACTIVE_TURN_SLOT = -1;
const GAME_AUTH_ISSUER = "stella-game";
const GAME_AUTH_AUDIENCE = "stella-hosted-game";
const GAME_AUTH_VERSION = 1;
const GAME_REGISTRATION_TTL_MS = 24n * 60n * 60n * 1000n;
const GAME_AUTH_PUBLIC_KEY_BASE64URL = "HQU9NBm0-pzP56UJ-VUX4VNxcR25YxwFp21yy0WlLiY";
const TICK_INTERVAL_MIN_MS = 16;
const TICK_INTERVAL_MAX_MS = 60_000;
const MAX_SERVER_TICK_RATE_HZ = 60;
const DEFAULT_SNAPSHOT_RETENTION_SECONDS = 5;
const DEFAULT_ENTITY_LIFECYCLE_ACTIVE = "active";

const sessions = table(
  { name: "sessions", public: true },
  {
    session_id: t.u64().primaryKey().autoInc(),
    game_id: t.string().index(),
    join_code: t.string().unique(),
    host_identity: t.identity(),
    host_user_id: t.string(),
    game_type: t.string().index(),
    lifecycle_state: t.string().index(),
    phase_key: t.string(),
    runtime_kind: t.string(),
    ruleset_key: t.string(),
    min_players: t.u32(),
    max_players: t.u32(),
    active_turn_slot: t.i32(),
    simulation_tick: t.u32(),
    tick_rate_hz: t.u32(),
    snapshot_rate_hz: t.u32(),
    interest_mode: t.string(),
    partition_size: t.f32(),
    public_state_json: t.string(),
    metadata_json: t.string(),
    created_at: t.u64(),
    updated_at: t.u64(),
    started_at: t.u64(),
    ended_at: t.u64(),
  },
);

const players = table(
  {
    name: "players",
    public: true,
    indexes: [
      { name: "session_slot", algorithm: "btree", columns: ["session_id", "slot"] },
      { name: "session_identity", algorithm: "btree", columns: ["session_id", "player_identity"] },
      { name: "session_user", algorithm: "btree", columns: ["session_id", "user_id"] },
      { name: "session_team", algorithm: "btree", columns: ["session_id", "team_id"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_identity: t.identity().index(),
    user_id: t.string().index(),
    display_name: t.string(),
    avatar_url: t.string(),
    slot: t.u32(),
    team_id: t.i32(),
    role_key: t.string(),
    pawn_entity_id: t.u64().optional(),
    score: t.i64(),
    lifecycle_state: t.string(),
    is_host: t.bool(),
    presence_json: t.string(),
    last_input_seq: t.u64(),
    metadata_json: t.string(),
    joined_at: t.u64(),
    last_seen_at: t.u64(),
  },
);

const entities = table(
  {
    name: "entities",
    public: true,
    indexes: [
      { name: "session_entity_key", algorithm: "btree", columns: ["session_id", "entity_key"] },
      { name: "session_archetype", algorithm: "btree", columns: ["session_id", "archetype"] },
      { name: "session_zone", algorithm: "btree", columns: ["session_id", "zone_key"] },
      { name: "session_owner_slot", algorithm: "btree", columns: ["session_id", "owner_slot"] },
      {
        name: "session_replication_group",
        algorithm: "btree",
        columns: ["session_id", "replication_group"],
      },
      {
        name: "session_visibility_scope",
        algorithm: "btree",
        columns: ["session_id", "visibility_scope"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    entity_key: t.string(),
    archetype: t.string().index(),
    parent_entity_id: t.u64().optional(),
    owner_slot: t.i32(),
    authority: t.string(),
    replication_group: t.string(),
    zone_key: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    qx: t.f32(),
    qy: t.f32(),
    qz: t.f32(),
    qw: t.f32(),
    sx: t.f32(),
    sy: t.f32(),
    sz: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    vz: t.f32(),
    simulation_tick: t.u32(),
    lifecycle_state: t.string(),
    state_json: t.string(),
    created_at: t.u64(),
    updated_at: t.u64(),
  },
);

const entityComponents = table(
  {
    name: "entity_components",
    public: true,
    indexes: [
      {
        name: "session_entity_component",
        algorithm: "btree",
        columns: ["session_id", "entity_id", "component_name"],
      },
      {
        name: "session_component_name",
        algorithm: "btree",
        columns: ["session_id", "component_name"],
      },
      {
        name: "session_replication_group",
        algorithm: "btree",
        columns: ["session_id", "replication_group"],
      },
      {
        name: "session_visibility_scope",
        algorithm: "btree",
        columns: ["session_id", "visibility_scope"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    entity_id: t.u64().index(),
    component_name: t.string(),
    schema_key: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    owner_slot: t.i32(),
    data_json: t.string(),
    updated_at: t.u64(),
  },
);

const sessionResources = table(
  {
    name: "session_resources",
    public: true,
    indexes: [
      {
        name: "session_resource_key",
        algorithm: "btree",
        columns: ["session_id", "resource_key"],
      },
      {
        name: "session_replication_group",
        algorithm: "btree",
        columns: ["session_id", "replication_group"],
      },
      {
        name: "session_visibility_scope",
        algorithm: "btree",
        columns: ["session_id", "visibility_scope"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    resource_key: t.string(),
    resource_scope: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    owner_slot: t.i32(),
    data_json: t.string(),
    updated_at: t.u64(),
  },
);

const sessionEvents = table(
  {
    name: "session_events",
    public: true,
    indexes: [
      { name: "session_tick", algorithm: "btree", columns: ["session_id", "simulation_tick"] },
      { name: "session_kind", algorithm: "btree", columns: ["session_id", "event_kind"] },
      { name: "session_scope", algorithm: "btree", columns: ["session_id", "event_scope"] },
      {
        name: "session_replication_group",
        algorithm: "btree",
        columns: ["session_id", "replication_group"],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    origin_slot: t.u32().optional(),
    target_entity_id: t.u64().optional(),
    event_kind: t.string().index(),
    event_scope: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    simulation_tick: t.u32(),
    data_json: t.string(),
    created_at: t.u64(),
  },
);

const inputFrames = table(
  {
    name: "input_frames",
    public: true,
    indexes: [
      {
        name: "session_player_seq",
        algorithm: "btree",
        columns: ["session_id", "player_slot", "input_seq"],
      },
      { name: "session_tick", algorithm: "btree", columns: ["session_id", "client_tick"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    player_slot: t.u32(),
    input_seq: t.u64(),
    client_tick: t.u32(),
    input_kind: t.string(),
    input_json: t.string(),
    created_at: t.u64(),
  },
);

const playerPrivateState = table(
  {
    name: "player_private_state",
    public: false,
    indexes: [
      { name: "session_identity", algorithm: "btree", columns: ["session_id", "player_identity"] },
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
    state_json: t.string(),
    updated_at: t.u64(),
  },
);

const entitySnapshots = table(
  {
    name: "entity_snapshots",
    public: false,
    indexes: [
      {
        name: "session_entity_tick",
        algorithm: "btree",
        columns: ["session_id", "entity_id", "simulation_tick"],
      },
      { name: "session_tick", algorithm: "btree", columns: ["session_id", "simulation_tick"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    session_id: t.u64().index(),
    entity_id: t.u64().index(),
    simulation_tick: t.u32(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    qx: t.f32(),
    qy: t.f32(),
    qz: t.f32(),
    qw: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    vz: t.f32(),
    state_json: t.string(),
    captured_at: t.u64(),
  },
);

const tickSchedules = table(
  { name: "tick_schedules", scheduled: "tick_session" },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    session_id: t.u64().index(),
  },
);

const authRegistrations = table(
  { name: "auth_registrations" },
  {
    id: t.u64().primaryKey().autoInc(),
    stdb_identity: t.identity().unique(),
    game_id: t.string().index(),
    user_id: t.string().index(),
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
  sessions,
  players,
  entities,
  entityComponents,
  sessionResources,
  sessionEvents,
  inputFrames,
  playerPrivateState,
  entitySnapshots,
  tickSchedules,
  authRegistrations,
  usedGameTokens,
);

type StellaDb = ReducerCtx<typeof spacetime.schemaType>["db"];
type SessionRow = ReturnType<StellaDb["sessions"]["session_id"]["find"]> extends infer T ? Exclude<T, null> : never;
type PlayerRow = ReturnType<StellaDb["players"]["id"]["find"]> extends infer T ? Exclude<T, null> : never;
type EntityRow = ReturnType<StellaDb["entities"]["id"]["find"]> extends infer T ? Exclude<T, null> : never;
type RegistrationRow = ReturnType<StellaDb["authRegistrations"]["stdb_identity"]["find"]> extends infer T ? Exclude<T, null> : never;

const myPrivateStateRow = t.row("MyPrivateStateRow", {
  id: t.u64(),
  session_id: t.u64(),
  player_identity: t.identity(),
  state_key: t.string(),
  state_json: t.string(),
  updated_at: t.u64(),
});

spacetime.view(
  { name: "my_private_state", public: true },
  t.array(myPrivateStateRow),
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

function nowMillis(ctx: ReducerCtx<typeof spacetime.schemaType>): bigint {
  return nowMicros(ctx) / 1000n;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeJoinCode(value: string): string {
  return value.trim().toUpperCase();
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

  if (version !== GAME_AUTH_VERSION) fail("Unsupported game launch token version.");
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

  const payload = parseGameAuthPayload(
    parseJsonRecord(new TextDecoder().decode(payloadBytes), "game_token"),
  );
  if (BigInt(payload.exp) < nowMillis(ctx)) {
    fail("Game launch token has expired.");
  }
  return payload;
}

function collectRows<T>(rows: Iterable<T>): T[] {
  return Array.from(rows);
}

function findFirst<T>(rows: Iterable<T>): T | null {
  for (const row of rows) {
    return row;
  }
  return null;
}

function getRegistration(ctx: ReducerCtx<typeof spacetime.schemaType>): RegistrationRow | null {
  return ctx.db.authRegistrations.stdb_identity.find(ctx.sender);
}

function requireRegistration(ctx: ReducerCtx<typeof spacetime.schemaType>): RegistrationRow {
  const registration = getRegistration(ctx) ?? fail("Register this player first.");
  if (registration.expires_at < nowMillis(ctx)) {
    ctx.db.authRegistrations.stdb_identity.delete(ctx.sender);
    fail("Game access expired. Reopen this game from Stella.");
  }
  return registration;
}

function requireRegistrationForGame(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  gameId: string,
): RegistrationRow {
  const registration = requireRegistration(ctx);
  if (registration.game_id !== gameId) {
    fail("This launch token is not valid for the current game.");
  }
  return registration;
}

function getSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): SessionRow {
  return ctx.db.sessions.session_id.find(sessionId) ?? fail("Session not found.");
}

function getSessionByJoinCode(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  joinCode: string,
): SessionRow {
  return ctx.db.sessions.join_code.find(normalizeJoinCode(joinCode)) ?? fail("Join code not found.");
}

function getPlayersForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): PlayerRow[] {
  return collectRows(ctx.db.players.session_slot.filter(sessionId));
}

function getPlayerByIdentity(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  identity: Identity,
): PlayerRow | null {
  return findFirst(ctx.db.players.session_identity.filter([sessionId, identity]));
}

function getRequiredPlayerByIdentity(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  identity: Identity,
): PlayerRow {
  return getPlayerByIdentity(ctx, sessionId, identity) ?? fail("You are not part of this session.");
}

function getPlayerBySlot(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  slot: number,
): PlayerRow | null {
  return findFirst(ctx.db.players.session_slot.filter([sessionId, slot]));
}

function getRequiredPlayerBySlot(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  slot: number,
): PlayerRow {
  return getPlayerBySlot(ctx, sessionId, slot) ?? fail("Player slot not found.");
}

function getEntity(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  entityId: bigint,
): EntityRow {
  return ctx.db.entities.id.find(entityId) ?? fail("Entity not found.");
}

function requireSessionPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: SessionRow,
): PlayerRow {
  requireRegistrationForGame(ctx, session.game_id);
  return getRequiredPlayerByIdentity(ctx, session.session_id, ctx.sender);
}

function requireHostPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: SessionRow,
): PlayerRow {
  const player = requireSessionPlayer(ctx, session);
  if (!player.is_host) {
    fail("Only the host can do that.");
  }
  return player;
}

function canUpdateSessionState(session: SessionRow, player: PlayerRow): boolean {
  if (player.is_host) {
    return true;
  }
  return session.active_turn_slot >= 0 && player.slot === session.active_turn_slot;
}

function requireSessionStateController(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: SessionRow,
): PlayerRow {
  const player = requireSessionPlayer(ctx, session);
  if (!canUpdateSessionState(session, player)) {
    fail("You do not have permission to update this session.");
  }
  return player;
}

function canControlEntity(
  session: SessionRow,
  player: PlayerRow,
  entity: EntityRow,
): boolean {
  if (player.is_host) return true;
  switch (entity.authority) {
    case "shared":
      return true;
    case "owner":
      return entity.owner_slot === player.slot;
    case "turn":
      return session.active_turn_slot >= 0 && session.active_turn_slot === player.slot;
    case "host":
    case "server":
    default:
      return false;
  }
}

function requireEntityController(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: SessionRow,
  entity: EntityRow,
): PlayerRow {
  const player = requireSessionPlayer(ctx, session);
  if (!canControlEntity(session, player, entity)) {
    fail("You do not have permission to control this entity.");
  }
  return player;
}

function deletePrivateStateForPlayer(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  identity: Identity,
): void {
  for (const row of ctx.db.playerPrivateState.session_identity.filter([sessionId, identity])) {
    ctx.db.playerPrivateState.id.delete(row.id);
  }
}

function deleteTickSchedulesForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): void {
  for (const row of ctx.db.tickSchedules.session_id.filter(sessionId)) {
    ctx.db.tickSchedules.scheduled_id.delete(row.scheduled_id);
  }
}

function getTickScheduleForSession(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
) {
  return findFirst(ctx.db.tickSchedules.session_id.filter(sessionId));
}

function validateLifecycle(
  session: SessionRow,
  expected: readonly string[],
): void {
  if (!expected.includes(session.lifecycle_state)) {
    fail(`Session must be ${expected.join(" or ")}.`);
  }
}

function countActivePlayers(playersForSession: readonly PlayerRow[]): number {
  return playersForSession.filter((player) => player.lifecycle_state === DEFAULT_LIFECYCLE_CONNECTED).length;
}

function getNextOpenSlot(playersForSession: readonly PlayerRow[]): number {
  let maxSlot = -1;
  for (const player of playersForSession) {
    if (player.slot > maxSlot) {
      maxSlot = player.slot;
    }
  }
  return maxSlot + 1;
}

function compactLobbySlots(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
): PlayerRow[] {
  const sorted = getPlayersForSession(ctx, sessionId).sort((left, right) => left.slot - right.slot);
  const compacted: PlayerRow[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    compacted.push(
      ctx.db.players.id.update({
        ...sorted[index],
        slot: index,
        is_host: false,
      }),
    );
  }
  return compacted;
}

function promoteLobbyHost(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  session: SessionRow,
): SessionRow {
  const compacted = compactLobbySlots(ctx, session.session_id);
  if (compacted.length === 0) {
    return ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: DEFAULT_LIFECYCLE_ABANDONED,
      updated_at: nowMicros(ctx),
      ended_at: nowMicros(ctx),
    });
  }

  const promoted = compacted[0];
  ctx.db.players.id.update({
    ...promoted,
    is_host: true,
  });

  return ctx.db.sessions.session_id.update({
    ...session,
    host_identity: promoted.player_identity,
    host_user_id: promoted.user_id,
    updated_at: nowMicros(ctx),
  });
}

function generateJoinCode(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let code = "";
    for (let index = 0; index < 4; index += 1) {
      const randomIndex = ctx.random.integerInRange(0, JOIN_CODE_ALPHABET.length - 1);
      code += JOIN_CODE_ALPHABET[randomIndex];
    }
    if (ctx.db.sessions.join_code.find(code) === null) {
      return code;
    }
  }
  fail("Unable to generate a unique join code. Please try again.");
}

function recordSessionEvent(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  args: {
    sessionId: bigint;
    eventKind: string;
    eventScope: string;
    replicationGroup: string;
    visibilityScope: string;
    visibilityKey?: string;
    originSlot?: number;
    targetEntityId?: bigint;
    simulationTick: number;
    dataJson: string;
  },
): void {
  ctx.db.sessionEvents.insert({
    id: 0n,
    session_id: args.sessionId,
    origin_slot: args.originSlot,
    target_entity_id: args.targetEntityId,
    event_kind: args.eventKind,
    event_scope: args.eventScope,
    replication_group: args.replicationGroup,
    visibility_scope: args.visibilityScope,
    visibility_key: args.visibilityKey,
    simulation_tick: args.simulationTick,
    data_json: args.dataJson,
    created_at: nowMicros(ctx),
  });
}

function upsertEntitySnapshot(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  args: {
    sessionId: bigint;
    entityId: bigint;
    simulationTick: number;
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
    vx: number;
    vy: number;
    vz: number;
    stateJson: string;
  },
): void {
  const existing = findFirst(
    ctx.db.entitySnapshots.session_entity_tick.filter([
      args.sessionId,
      args.entityId,
      args.simulationTick,
    ]),
  );

  if (existing) {
    ctx.db.entitySnapshots.id.update({
      ...existing,
      x: args.x,
      y: args.y,
      z: args.z,
      qx: args.qx,
      qy: args.qy,
      qz: args.qz,
      qw: args.qw,
      vx: args.vx,
      vy: args.vy,
      vz: args.vz,
      state_json: args.stateJson,
      captured_at: nowMicros(ctx),
    });
    return;
  }

  ctx.db.entitySnapshots.insert({
    id: 0n,
    session_id: args.sessionId,
    entity_id: args.entityId,
    simulation_tick: args.simulationTick,
    x: args.x,
    y: args.y,
    z: args.z,
    qx: args.qx,
    qy: args.qy,
    qz: args.qz,
    qw: args.qw,
    vx: args.vx,
    vy: args.vy,
    vz: args.vz,
    state_json: args.stateJson,
    captured_at: nowMicros(ctx),
  });
}

function getTickIntervalMs(scheduleAt: ScheduleAtValue): number {
  if (scheduleAt.tag === "Interval") {
    return scheduleAt.value.millis;
  }
  return 0;
}

function validateTickRate(value: number, fieldName: string): void {
  if (value < 1 || value > MAX_SERVER_TICK_RATE_HZ) {
    fail(`${fieldName} must be between 1 and ${MAX_SERVER_TICK_RATE_HZ}.`);
  }
}

function getTickIntervalMicrosForSession(session: SessionRow): bigint {
  const intervalMs = Math.max(
    TICK_INTERVAL_MIN_MS,
    Math.min(
      TICK_INTERVAL_MAX_MS,
      Math.round(1000 / Math.max(1, session.tick_rate_hz)),
    ),
  );
  return BigInt(intervalMs) * 1000n;
}

function getSnapshotStride(session: SessionRow): number {
  const requestedRate = Math.max(1, session.snapshot_rate_hz);
  return Math.max(1, Math.round(session.tick_rate_hz / requestedRate));
}

function pruneSnapshotsBeforeTick(
  ctx: ReducerCtx<typeof spacetime.schemaType>,
  sessionId: bigint,
  keepSinceTick: number,
): void {
  for (const snapshot of ctx.db.entitySnapshots.session_tick.filter(sessionId)) {
    if (snapshot.simulation_tick < keepSinceTick) {
      ctx.db.entitySnapshots.id.delete(snapshot.id);
    }
  }
}

spacetime.reducer(
  "register_player",
  {
    game_token: t.string(),
  },
  (ctx, { game_token }) => {
    const payload = verifyGameLaunchToken(game_token, ctx);
    const tokenUse = ctx.db.usedGameTokens.jti.find(payload.jti);
    if (tokenUse) {
      fail("This game launch token has already been used.");
    }

    ctx.db.usedGameTokens.insert({
      id: 0n,
      jti: payload.jti,
      stdb_identity: ctx.sender,
      game_id: payload.gameId,
      used_at: nowMicros(ctx),
    });

    const current = ctx.db.authRegistrations.stdb_identity.find(ctx.sender);
    const nextRegistration = {
      id: current?.id ?? 0n,
      stdb_identity: ctx.sender,
      game_id: payload.gameId,
      user_id: payload.sub,
      display_name: payload.displayName,
      expires_at: nowMillis(ctx) + GAME_REGISTRATION_TTL_MS,
      registered_at: nowMicros(ctx),
    };

    if (current) {
      ctx.db.authRegistrations.stdb_identity.update(nextRegistration);
      return;
    }

    ctx.db.authRegistrations.insert(nextRegistration);
  },
);

spacetime.reducer(
  "create_session",
  {
    game_type: t.string(),
    ruleset_key: t.string(),
    min_players: t.u32(),
    max_players: t.u32(),
    runtime_kind: t.string(),
    tick_rate_hz: t.u32(),
    snapshot_rate_hz: t.u32(),
    interest_mode: t.string(),
    partition_size: t.f32(),
    public_state_json: t.string(),
    metadata_json: t.string(),
  },
  (ctx, args) => {
    const registration = requireRegistration(ctx);
    const gameType = args.game_type.trim() || fail("game_type is required.");
    const rulesetKey = args.ruleset_key.trim() || DEFAULT_RULESET_KEY;

    if (args.min_players < 1) fail("min_players must be at least 1.");
    if (args.max_players < args.min_players) {
      fail("max_players must be greater than or equal to min_players.");
    }
    validateTickRate(args.tick_rate_hz, "tick_rate_hz");
    validateTickRate(args.snapshot_rate_hz, "snapshot_rate_hz");
    if (args.partition_size <= 0) {
      fail("partition_size must be greater than zero.");
    }

    parseJsonRecord(args.public_state_json, "public_state_json");
    parseJsonRecord(args.metadata_json, "metadata_json");

    const createdAt = nowMicros(ctx);
    const session = ctx.db.sessions.insert({
      session_id: 0n,
      game_id: registration.game_id,
      join_code: generateJoinCode(ctx),
      host_identity: ctx.sender,
      host_user_id: registration.user_id,
      game_type: gameType,
      lifecycle_state: DEFAULT_LIFECYCLE_LOBBY,
      phase_key: DEFAULT_PHASE_KEY,
      runtime_kind: args.runtime_kind.trim() || DEFAULT_RUNTIME_KIND,
      ruleset_key: rulesetKey,
      min_players: args.min_players,
      max_players: args.max_players,
      active_turn_slot: NO_ACTIVE_TURN_SLOT,
      simulation_tick: 0,
      tick_rate_hz: args.tick_rate_hz,
      snapshot_rate_hz: args.snapshot_rate_hz,
      interest_mode: args.interest_mode.trim() || DEFAULT_INTEREST_MODE,
      partition_size: args.partition_size,
      public_state_json: args.public_state_json,
      metadata_json: args.metadata_json,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: 0n,
      ended_at: 0n,
    });

    ctx.db.players.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: ctx.sender,
      user_id: registration.user_id,
      display_name: registration.display_name,
      avatar_url: "",
      slot: 0,
      team_id: -1,
      role_key: "",
      pawn_entity_id: undefined,
      score: 0n,
      lifecycle_state: DEFAULT_LIFECYCLE_CONNECTED,
      is_host: true,
      presence_json: EMPTY_JSON_OBJECT,
      last_input_seq: 0n,
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
    requested_team_id: t.i32().optional(),
    requested_role_key: t.string().optional(),
  },
  (ctx, { join_code, requested_team_id, requested_role_key }) => {
    const registration = requireRegistration(ctx);
    const session = getSessionByJoinCode(ctx, join_code);
    if (session.game_id !== registration.game_id) {
      fail("This launch token cannot join that session.");
    }
    validateLifecycle(session, [DEFAULT_LIFECYCLE_LOBBY]);

    const sessionPlayers = getPlayersForSession(ctx, session.session_id);
    if (sessionPlayers.length >= session.max_players) {
      fail("This session is full.");
    }
    if (getPlayerByIdentity(ctx, session.session_id, ctx.sender)) {
      fail("You have already joined this session.");
    }

    const joinedAt = nowMicros(ctx);
    ctx.db.players.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: ctx.sender,
      user_id: registration.user_id,
      display_name: registration.display_name,
      avatar_url: "",
      slot: getNextOpenSlot(sessionPlayers),
      team_id: requested_team_id ?? -1,
      role_key: requested_role_key?.trim() ?? "",
      pawn_entity_id: undefined,
      score: 0n,
      lifecycle_state: DEFAULT_LIFECYCLE_CONNECTED,
      is_host: false,
      presence_json: EMPTY_JSON_OBJECT,
      last_input_seq: 0n,
      metadata_json: EMPTY_JSON_OBJECT,
      joined_at: joinedAt,
      last_seen_at: joinedAt,
    });

    ctx.db.sessions.session_id.update({
      ...session,
      updated_at: joinedAt,
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
    const player = requireSessionPlayer(ctx, session);

    if (session.lifecycle_state === DEFAULT_LIFECYCLE_LOBBY) {
      deletePrivateStateForPlayer(ctx, session.session_id, player.player_identity);
      ctx.db.players.id.delete(player.id);
      if (player.is_host) {
        promoteLobbyHost(ctx, session);
      } else {
        compactLobbySlots(ctx, session.session_id);
        ctx.db.sessions.session_id.update({
          ...session,
          updated_at: nowMicros(ctx),
        });
      }
      return;
    }

    ctx.db.players.id.update({
      ...player,
      lifecycle_state: "disconnected",
      last_seen_at: nowMicros(ctx),
    });

    ctx.db.sessions.session_id.update({
      ...session,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "start_session",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateLifecycle(session, [DEFAULT_LIFECYCLE_LOBBY]);

    if (countActivePlayers(getPlayersForSession(ctx, session.session_id)) < session.min_players) {
      fail("Not enough players to start.");
    }

    ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: DEFAULT_LIFECYCLE_RUNNING,
      started_at: nowMicros(ctx),
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "pause_session",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateLifecycle(session, [DEFAULT_LIFECYCLE_RUNNING]);
    deleteTickSchedulesForSession(ctx, session.session_id);
    ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: DEFAULT_LIFECYCLE_PAUSED,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "resume_session",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateLifecycle(session, [DEFAULT_LIFECYCLE_PAUSED]);
    ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: DEFAULT_LIFECYCLE_RUNNING,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "end_session",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    deleteTickSchedulesForSession(ctx, session.session_id);
    ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: DEFAULT_LIFECYCLE_ENDED,
      ended_at: nowMicros(ctx),
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "configure_session_runtime",
  {
    session_id: t.u64(),
    runtime_kind: t.string(),
    tick_rate_hz: t.u32(),
    snapshot_rate_hz: t.u32(),
    interest_mode: t.string(),
    partition_size: t.f32(),
  },
  (ctx, { session_id, runtime_kind, tick_rate_hz, snapshot_rate_hz, interest_mode, partition_size }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateTickRate(tick_rate_hz, "tick_rate_hz");
    validateTickRate(snapshot_rate_hz, "snapshot_rate_hz");
    if (partition_size <= 0) fail("partition_size must be greater than zero.");

    ctx.db.sessions.session_id.update({
      ...session,
      runtime_kind: runtime_kind.trim() || DEFAULT_RUNTIME_KIND,
      tick_rate_hz,
      snapshot_rate_hz,
      interest_mode: interest_mode.trim() || DEFAULT_INTEREST_MODE,
      partition_size,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "update_session_state",
  {
    session_id: t.u64(),
    expected_simulation_tick: t.u32(),
    lifecycle_state: t.string(),
    phase_key: t.string(),
    active_turn_slot: t.i32(),
    simulation_tick: t.u32(),
    public_state_json: t.string(),
    metadata_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    requireSessionStateController(ctx, session);
    if (session.simulation_tick !== args.expected_simulation_tick) {
      fail("Session state is stale. Refresh and try again.");
    }

    parseJsonRecord(args.public_state_json, "public_state_json");
    parseJsonRecord(args.metadata_json, "metadata_json");

    ctx.db.sessions.session_id.update({
      ...session,
      lifecycle_state: args.lifecycle_state.trim() || session.lifecycle_state,
      phase_key: args.phase_key.trim() || session.phase_key,
      active_turn_slot: args.active_turn_slot,
      simulation_tick: args.simulation_tick,
      public_state_json: args.public_state_json,
      metadata_json: args.metadata_json,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "spawn_entity",
  {
    session_id: t.u64(),
    entity_key: t.string(),
    archetype: t.string(),
    parent_entity_id: t.u64().optional(),
    owner_slot: t.i32(),
    authority: t.string(),
    replication_group: t.string(),
    zone_key: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    qx: t.f32(),
    qy: t.f32(),
    qz: t.f32(),
    qw: t.f32(),
    sx: t.f32(),
    sy: t.f32(),
    sz: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    vz: t.f32(),
    simulation_tick: t.u32(),
    lifecycle_state: t.string(),
    state_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    requireSessionStateController(ctx, session);
    parseJsonRecord(args.state_json, "state_json");

    ctx.db.entities.insert({
      id: 0n,
      session_id: args.session_id,
      entity_key: args.entity_key.trim() || fail("entity_key is required."),
      archetype: args.archetype.trim() || fail("archetype is required."),
      parent_entity_id: args.parent_entity_id,
      owner_slot: args.owner_slot,
      authority: args.authority.trim() || DEFAULT_ENTITY_AUTHORITY,
      replication_group: args.replication_group.trim() || DEFAULT_REPLICATION_GROUP,
      zone_key: args.zone_key.trim() || DEFAULT_ZONE_KEY,
      visibility_scope: args.visibility_scope.trim() || DEFAULT_VISIBILITY_SCOPE,
      visibility_key:
        args.visibility_key !== undefined && args.visibility_key.trim()
          ? args.visibility_key.trim()
          : undefined,
      x: args.x,
      y: args.y,
      z: args.z,
      qx: args.qx,
      qy: args.qy,
      qz: args.qz,
      qw: args.qw,
      sx: args.sx,
      sy: args.sy,
      sz: args.sz,
      vx: args.vx,
      vy: args.vy,
      vz: args.vz,
      simulation_tick: args.simulation_tick,
      lifecycle_state: args.lifecycle_state.trim() || DEFAULT_ENTITY_LIFECYCLE_ACTIVE,
      state_json: args.state_json,
      created_at: nowMicros(ctx),
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "update_entity_transform",
  {
    id: t.u64(),
    replication_group: t.string(),
    zone_key: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    qx: t.f32(),
    qy: t.f32(),
    qz: t.f32(),
    qw: t.f32(),
    sx: t.f32(),
    sy: t.f32(),
    sz: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    vz: t.f32(),
    simulation_tick: t.u32(),
    lifecycle_state: t.string(),
    state_json: t.string(),
  },
  (ctx, args) => {
    const entity = getEntity(ctx, args.id);
    const session = getSession(ctx, entity.session_id);
    requireEntityController(ctx, session, entity);
    parseJsonRecord(args.state_json, "state_json");

    ctx.db.entities.id.update({
      ...entity,
      replication_group: args.replication_group.trim() || entity.replication_group,
      zone_key: args.zone_key.trim() || entity.zone_key,
      visibility_scope: args.visibility_scope.trim() || entity.visibility_scope,
      visibility_key:
        args.visibility_key !== undefined && args.visibility_key.trim()
          ? args.visibility_key.trim()
          : undefined,
      x: args.x,
      y: args.y,
      z: args.z,
      qx: args.qx,
      qy: args.qy,
      qz: args.qz,
      qw: args.qw,
      sx: args.sx,
      sy: args.sy,
      sz: args.sz,
      vx: args.vx,
      vy: args.vy,
      vz: args.vz,
      simulation_tick: args.simulation_tick,
      lifecycle_state: args.lifecycle_state.trim() || entity.lifecycle_state,
      state_json: args.state_json,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "despawn_entity",
  {
    id: t.u64(),
  },
  (ctx, { id }) => {
    const entity = getEntity(ctx, id);
    const session = getSession(ctx, entity.session_id);
    requireEntityController(ctx, session, entity);

    for (const component of ctx.db.entityComponents.session_entity_component.filter([
      entity.session_id,
      entity.id,
    ])) {
      ctx.db.entityComponents.id.delete(component.id);
    }

    ctx.db.entities.id.delete(entity.id);
  },
);

spacetime.reducer(
  "upsert_entity_component",
  {
    session_id: t.u64(),
    entity_id: t.u64(),
    component_name: t.string(),
    schema_key: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    owner_slot: t.i32(),
    data_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    const entity = getEntity(ctx, args.entity_id);
    if (entity.session_id !== session.session_id) {
      fail("Entity does not belong to this session.");
    }
    requireEntityController(ctx, session, entity);
    parseJsonRecord(args.data_json, "data_json");

    const componentName = args.component_name.trim() || fail("component_name is required.");
    const existing = findFirst(
      ctx.db.entityComponents.session_entity_component.filter([
        session.session_id,
        entity.id,
        componentName,
      ]),
    );

    if (existing) {
      ctx.db.entityComponents.id.update({
        ...existing,
        schema_key: args.schema_key.trim() || existing.schema_key,
        replication_group: args.replication_group.trim() || existing.replication_group,
        visibility_scope: args.visibility_scope.trim() || existing.visibility_scope,
        visibility_key:
          args.visibility_key !== undefined && args.visibility_key.trim()
            ? args.visibility_key.trim()
            : undefined,
        owner_slot: args.owner_slot,
        data_json: args.data_json,
        updated_at: nowMicros(ctx),
      });
      return;
    }

    ctx.db.entityComponents.insert({
      id: 0n,
      session_id: session.session_id,
      entity_id: entity.id,
      component_name: componentName,
      schema_key: args.schema_key.trim() || componentName,
      replication_group: args.replication_group.trim() || DEFAULT_REPLICATION_GROUP,
      visibility_scope: args.visibility_scope.trim() || DEFAULT_VISIBILITY_SCOPE,
      visibility_key:
        args.visibility_key !== undefined && args.visibility_key.trim()
          ? args.visibility_key.trim()
          : undefined,
      owner_slot: args.owner_slot,
      data_json: args.data_json,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "remove_entity_component",
  {
    session_id: t.u64(),
    entity_id: t.u64(),
    component_name: t.string(),
  },
  (ctx, { session_id, entity_id, component_name }) => {
    const session = getSession(ctx, session_id);
    const entity = getEntity(ctx, entity_id);
    if (entity.session_id !== session.session_id) {
      fail("Entity does not belong to this session.");
    }
    requireEntityController(ctx, session, entity);

    const existing = findFirst(
      ctx.db.entityComponents.session_entity_component.filter([
        session.session_id,
        entity.id,
        component_name.trim(),
      ]),
    );
    if (existing) {
      ctx.db.entityComponents.id.delete(existing.id);
    }
  },
);

spacetime.reducer(
  "upsert_session_resource",
  {
    session_id: t.u64(),
    resource_key: t.string(),
    resource_scope: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    owner_slot: t.i32(),
    data_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    requireHostPlayer(ctx, session);
    parseJsonRecord(args.data_json, "data_json");
    const resourceKey = args.resource_key.trim() || fail("resource_key is required.");

    const existing = findFirst(
      ctx.db.sessionResources.session_resource_key.filter([
        session.session_id,
        resourceKey,
      ]),
    );

    if (existing) {
      ctx.db.sessionResources.id.update({
        ...existing,
        resource_scope: args.resource_scope.trim() || existing.resource_scope,
        replication_group: args.replication_group.trim() || existing.replication_group,
        visibility_scope: args.visibility_scope.trim() || existing.visibility_scope,
        visibility_key:
          args.visibility_key !== undefined && args.visibility_key.trim()
            ? args.visibility_key.trim()
            : undefined,
        owner_slot: args.owner_slot,
        data_json: args.data_json,
        updated_at: nowMicros(ctx),
      });
      return;
    }

    ctx.db.sessionResources.insert({
      id: 0n,
      session_id: session.session_id,
      resource_key: resourceKey,
      resource_scope: args.resource_scope.trim() || DEFAULT_RESOURCE_SCOPE,
      replication_group: args.replication_group.trim() || DEFAULT_REPLICATION_GROUP,
      visibility_scope: args.visibility_scope.trim() || DEFAULT_VISIBILITY_SCOPE,
      visibility_key:
        args.visibility_key !== undefined && args.visibility_key.trim()
          ? args.visibility_key.trim()
          : undefined,
      owner_slot: args.owner_slot,
      data_json: args.data_json,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "remove_session_resource",
  {
    session_id: t.u64(),
    resource_key: t.string(),
  },
  (ctx, { session_id, resource_key }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const existing = findFirst(
      ctx.db.sessionResources.session_resource_key.filter([
        session.session_id,
        resource_key.trim(),
      ]),
    );
    if (existing) {
      ctx.db.sessionResources.id.delete(existing.id);
    }
  },
);

spacetime.reducer(
  "emit_session_event",
  {
    session_id: t.u64(),
    event_kind: t.string(),
    event_scope: t.string(),
    replication_group: t.string(),
    visibility_scope: t.string(),
    visibility_key: t.string().optional(),
    target_entity_id: t.u64().optional(),
    simulation_tick: t.u32(),
    data_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    const player = requireSessionPlayer(ctx, session);
    parseJsonRecord(args.data_json, "data_json");

    if (args.target_entity_id !== undefined) {
      const entity = getEntity(ctx, args.target_entity_id);
      if (entity.session_id !== session.session_id) {
        fail("Target entity does not belong to this session.");
      }
    }

    recordSessionEvent(ctx, {
      sessionId: session.session_id,
      eventKind: args.event_kind.trim() || fail("event_kind is required."),
      eventScope: args.event_scope.trim() || DEFAULT_EVENT_SCOPE,
      replicationGroup: args.replication_group.trim() || DEFAULT_REPLICATION_GROUP,
      visibilityScope: args.visibility_scope.trim() || DEFAULT_VISIBILITY_SCOPE,
      visibilityKey:
        args.visibility_key !== undefined && args.visibility_key.trim()
          ? args.visibility_key.trim()
          : undefined,
      originSlot: player.slot,
      targetEntityId: args.target_entity_id,
      simulationTick: args.simulation_tick,
      dataJson: args.data_json,
    });
  },
);

spacetime.reducer(
  "submit_input_frame",
  {
    session_id: t.u64(),
    input_seq: t.u64(),
    client_tick: t.u32(),
    input_kind: t.string(),
    input_json: t.string(),
  },
  (ctx, args) => {
    const session = getSession(ctx, args.session_id);
    const player = requireSessionPlayer(ctx, session);
    parseJsonRecord(args.input_json, "input_json");

    ctx.db.inputFrames.insert({
      id: 0n,
      session_id: session.session_id,
      player_slot: player.slot,
      input_seq: args.input_seq,
      client_tick: args.client_tick,
      input_kind: args.input_kind.trim() || DEFAULT_INPUT_KIND,
      input_json: args.input_json,
      created_at: nowMicros(ctx),
    });

    ctx.db.players.id.update({
      ...player,
      last_input_seq: args.input_seq,
      last_seen_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "capture_snapshot",
  {
    session_id: t.u64(),
    entity_id: t.u64().optional(),
    simulation_tick: t.u32().optional(),
  },
  (ctx, { session_id, entity_id, simulation_tick }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const tick = simulation_tick ?? session.simulation_tick;

    if (entity_id !== undefined) {
      const entity = getEntity(ctx, entity_id);
      if (entity.session_id !== session.session_id) {
        fail("Entity does not belong to this session.");
      }

      upsertEntitySnapshot(ctx, {
        sessionId: session.session_id,
        entityId: entity.id,
        simulationTick: tick,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        qx: entity.qx,
        qy: entity.qy,
        qz: entity.qz,
        qw: entity.qw,
        vx: entity.vx,
        vy: entity.vy,
        vz: entity.vz,
        stateJson: entity.state_json,
      });
      return;
    }

    for (const entity of ctx.db.entities.session_id.filter(session.session_id)) {
      upsertEntitySnapshot(ctx, {
        sessionId: session.session_id,
        entityId: entity.id,
        simulationTick: tick,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        qx: entity.qx,
        qy: entity.qy,
        qz: entity.qz,
        qw: entity.qw,
        vx: entity.vx,
        vy: entity.vy,
        vz: entity.vz,
        stateJson: entity.state_json,
      });
    }
  },
);

spacetime.reducer(
  "prune_snapshots",
  {
    session_id: t.u64(),
    keep_since_tick: t.u32(),
  },
  (ctx, { session_id, keep_since_tick }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    pruneSnapshotsBeforeTick(ctx, session.session_id, keep_since_tick);
  },
);

spacetime.reducer(
  "assign_player_pawn",
  {
    session_id: t.u64(),
    player_slot: t.u32(),
    pawn_entity_id: t.u64().optional(),
  },
  (ctx, { session_id, player_slot, pawn_entity_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const player = getRequiredPlayerBySlot(ctx, session.session_id, player_slot);

    if (pawn_entity_id !== undefined) {
      const entity = getEntity(ctx, pawn_entity_id);
      if (entity.session_id !== session.session_id) {
        fail("Pawn entity does not belong to this session.");
      }
    }

    ctx.db.players.id.update({
      ...player,
      pawn_entity_id,
      last_seen_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "update_player_presence",
  {
    session_id: t.u64(),
    presence_json: t.string(),
  },
  (ctx, { session_id, presence_json }) => {
    const session = getSession(ctx, session_id);
    const player = requireSessionPlayer(ctx, session);
    parseJsonRecord(presence_json, "presence_json");

    ctx.db.players.id.update({
      ...player,
      presence_json,
      last_seen_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "adjust_player_score",
  {
    session_id: t.u64(),
    player_slot: t.u32(),
    score_delta: t.i64(),
  },
  (ctx, { session_id, player_slot, score_delta }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    const player = getRequiredPlayerBySlot(ctx, session.session_id, player_slot);

    ctx.db.players.id.update({
      ...player,
      score: player.score + score_delta,
      last_seen_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "upsert_private_state",
  {
    session_id: t.u64(),
    target_player_slot: t.u32().optional(),
    state_key: t.string(),
    state_json: t.string(),
  },
  (ctx, { session_id, target_player_slot, state_key, state_json }) => {
    const session = getSession(ctx, session_id);
    const caller = requireSessionPlayer(ctx, session);
    parseJsonRecord(state_json, "state_json");

    const target =
      target_player_slot === undefined
        ? caller
        : getRequiredPlayerBySlot(ctx, session.session_id, target_player_slot);

    if (!caller.is_host && target.id !== caller.id) {
      fail("You can only update your own private state.");
    }

    const stateKey = state_key.trim() || fail("state_key is required.");
    const existing = findFirst(
      ctx.db.playerPrivateState.session_identity_state_key.filter([
        session.session_id,
        target.player_identity,
        stateKey,
      ]),
    );

    if (existing) {
      ctx.db.playerPrivateState.id.update({
        ...existing,
        state_json,
        updated_at: nowMicros(ctx),
      });
      return;
    }

    ctx.db.playerPrivateState.insert({
      id: 0n,
      session_id: session.session_id,
      player_identity: target.player_identity,
      state_key: stateKey,
      state_json,
      updated_at: nowMicros(ctx),
    });
  },
);

spacetime.reducer(
  "remove_private_state",
  {
    session_id: t.u64(),
    target_player_slot: t.u32().optional(),
    state_key: t.string(),
  },
  (ctx, { session_id, target_player_slot, state_key }) => {
    const session = getSession(ctx, session_id);
    const caller = requireSessionPlayer(ctx, session);

    const target =
      target_player_slot === undefined
        ? caller
        : getRequiredPlayerBySlot(ctx, session.session_id, target_player_slot);

    if (!caller.is_host && target.id !== caller.id) {
      fail("You can only clear your own private state.");
    }

    const existing = findFirst(
      ctx.db.playerPrivateState.session_identity_state_key.filter([
        session.session_id,
        target.player_identity,
        state_key.trim(),
      ]),
    );

    if (existing) {
      ctx.db.playerPrivateState.id.delete(existing.id);
    }
  },
);

const tickSessionReducer = spacetime.reducer(
  "tick_session",
  {
    arg: tickSchedules.rowType,
  },
  (ctx, { arg }) => {
    const session = getSession(ctx, arg.session_id);
    const schedule = ctx.db.tickSchedules.scheduled_id.find(arg.scheduled_id);

    if (schedule === null) {
      fail("Tick schedule not found.");
    }

    if (!ctx.senderAuth.isInternal) {
      requireHostPlayer(ctx, session);
    }

    if (session.lifecycle_state !== DEFAULT_LIFECYCLE_RUNNING) {
      ctx.db.tickSchedules.scheduled_id.delete(schedule.scheduled_id);
      return;
    }

    const nextTick = session.simulation_tick + 1;
    ctx.db.sessions.session_id.update({
      ...session,
      simulation_tick: nextTick,
      updated_at: nowMicros(ctx),
    });

    recordSessionEvent(ctx, {
      sessionId: session.session_id,
      eventKind: "session.tick",
      eventScope: "system",
      replicationGroup: DEFAULT_REPLICATION_GROUP,
      visibilityScope: DEFAULT_VISIBILITY_SCOPE,
      simulationTick: nextTick,
      dataJson: JSON.stringify({
        scheduledId: arg.scheduled_id.toString(),
        tickIntervalMs: getTickIntervalMs(arg.scheduled_at),
      }),
    });

    if (nextTick % getSnapshotStride(session) === 0) {
      for (const entity of ctx.db.entities.session_id.filter(session.session_id)) {
        upsertEntitySnapshot(ctx, {
          sessionId: session.session_id,
          entityId: entity.id,
          simulationTick: nextTick,
          x: entity.x,
          y: entity.y,
          z: entity.z,
          qx: entity.qx,
          qy: entity.qy,
          qz: entity.qz,
          qw: entity.qw,
          vx: entity.vx,
          vy: entity.vy,
          vz: entity.vz,
          stateJson: entity.state_json,
        });
      }

      const retentionTicks = Math.max(
        session.snapshot_rate_hz,
        session.snapshot_rate_hz * DEFAULT_SNAPSHOT_RETENTION_SECONDS,
      );
      if (nextTick > retentionTicks) {
        pruneSnapshotsBeforeTick(
          ctx,
          session.session_id,
          nextTick - retentionTicks,
        );
      }
    }
  },
);

spacetime.reducer(
  "start_tick_loop",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    validateLifecycle(session, [DEFAULT_LIFECYCLE_RUNNING]);

    deleteTickSchedulesForSession(ctx, session.session_id);

    ctx.db.tickSchedules.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(getTickIntervalMicrosForSession(session)),
      session_id: session.session_id,
    });
  },
);

spacetime.reducer(
  "stop_tick_loop",
  {
    session_id: t.u64(),
  },
  (ctx, { session_id }) => {
    const session = getSession(ctx, session_id);
    requireHostPlayer(ctx, session);
    deleteTickSchedulesForSession(ctx, session.session_id);
  },
);
