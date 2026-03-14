# Build the Stella SpacetimeDB Game Module

## Setup

The `spacetimedb` npm package is already installed. The SpacetimeDB CLI is at `C:\Users\Rahul\AppData\Local\SpacetimeDB\spacetime.exe`. Build with `spacetime build`, publish with `spacetime publish stella-w08uu -s maincloud`.

## Critical: Read the SDK types first

The SpacetimeDB TypeScript SDK is very new and docs are inaccurate. Before writing any code, read the actual type definitions in `node_modules/spacetimedb/dist/server/` and `node_modules/spacetimedb/dist/lib/`. These are the source of truth for:
- How `schema()`, `table()`, `t.*` column builders work
- How reducers are defined (name string, args schema, handler)
- How `ctx.db` accessors work (table variable names become camelCase accessors)
- How `ScheduleAt`, `Identity`, `Timestamp`, `TimeDuration` types work
- How views are defined
- What `SenderError` is

Do NOT trust the online docs at spacetimedb.com — they lag behind the SDK.

## What to build

A single `src/index.ts` file (plus optional `src/lib/` helpers) that defines a generic multiplayer game module. One deployment supports any game type — game-specific rules live in client code.

### Tables needed

All use `table({ name: "...", public: true/false }, { columns... })` and are passed to `schema(table1, table2, ...)`.

1. **game_sessions** (public) — Session state. Columns: session_id (PK auto-inc), join_code (unique, 4-char uppercase alphanumeric), host_identity (Identity), host_convex_id (string), game_type (string, indexed), status (string, indexed — "lobby"|"active"|"paused"|"finished"|"abandoned"), config_json (string), state_json (string), current_turn_player_slot (u32), turn_number (u32), max_players (u32), created_at/updated_at/started_at/ended_at (u64, microseconds)

2. **game_players** (public) — Player slots. Columns: id (PK auto-inc), session_id (u64, indexed), player_identity (Identity, indexed), convex_user_id (string), display_name (string), avatar_url (string), slot (u32), score (i64), status (string — "connected"|"disconnected"|"spectating"|"eliminated"), is_host (u8, 0 or 1), metadata_json (string), joined_at/last_seen_at (u64)

3. **player_private_state** (NOT public) — Hidden per-player state (card hands, secret roles). Columns: id (PK auto-inc), session_id (u64, indexed), player_identity (Identity, indexed), state_key (string), state_value (string), updated_at (u64). Needs a companion view that filters by `ctx.sender` so each player only sees their own rows.

4. **game_objects** (public) — Generic game entities (cards, pieces, tiles). Columns: id (PK auto-inc), session_id (u64, indexed), object_type (string, indexed), object_key (string), owner_slot (i32, -1=unowned), position_json (string), state_json (string), sort_order (u32), created_at/updated_at (u64)

5. **game_actions** (public) — Event-sourced action log. Columns: id (PK auto-inc), session_id (u64, indexed), player_slot (u32), turn_number (u32), action_type (string, indexed), payload_json (string), result_json (string), timestamp (u64)

6. **game_chat** (public) — In-game messaging. Columns: id (PK auto-inc), session_id (u64, indexed), player_slot (u32), display_name (string), message (string), message_type (string — "text"|"emote"), timestamp (u64)

7. **game_tick_schedule** (scheduled table, triggers `game_tick` reducer) — For timer-based games. Columns: scheduled_id (PK auto-inc), scheduled_at (scheduleAt type), session_id (u64)

8. **identity_map** (NOT public) — Maps SpacetimeDB Identity → Convex user ID. Columns: id (PK auto-inc), stdb_identity (Identity, unique), convex_user_id (string, indexed), display_name (string), registered_at (u64)

### Reducers needed

All defined via `schema.reducer("snake_case_name", { arg_name: t.type() }, (ctx, args) => { ... })`.

**Auth:**
- `register_player` — Takes convex_token (string) and display_name (string). Extracts `sub` claim from JWT payload (base64 decode middle segment), stores Identity→convex_user_id mapping in identity_map. Upsert pattern.

**Session lifecycle:**
- `create_session` — Generate 4-char join code (alphabet: ABCDEFGHJKMNPQRSTUVWXYZ23456789, retry on collision up to 5x), insert session in "lobby" status, insert host as player slot 0
- `join_session` — Look up by join_code, verify "lobby" status, check capacity, check no double-join, assign next slot
- `leave_session` — In lobby: delete player, handle host promotion. During game: mark "disconnected"
- `start_game` — Host only. Verify min 2 players. Set status to "active", turn_number to 1
- `end_game` — Host only. Set "finished", stop tick timers, log game_ended action
- `pause_game` — Host only. Toggle between "active" and "paused"

**Game actions:**
- `submit_action` — Verify active session, authorized player, turn validation (slot 0 = free-form, anyone can act; slot > 0 = turn-based). Log to game_actions. Auto-advance turn in turn-based mode.
- `update_session_state` — Host or turn player only. Optimistic concurrency (verify turn_number matches). Updates state_json and turn state.

**Objects:**
- `create_object`, `update_object`, `remove_object` — Host or turn player (or object owner for update). Standard CRUD on game_objects.

**Players:**
- `update_player_score` — Host only. Adds score_delta to target player.
- `update_player_private_state` — Host can set any player's state, players can set their own. Upsert by (session_id, player_identity, state_key).

**Chat:**
- `send_chat` — Truncate to 500 chars, insert into game_chat.

**Tick timer:**
- `game_tick` — Scheduled reducer. Reads turnTimerMs from state_json, decrements by tickIntervalMs, auto-advances turn on expiry. Self-cleans if session is not active.
- `start_tick_timer` — Host only. Inserts into game_tick_schedule with interval. Validate 100-60000ms range.
- `stop_tick_timer` — Host only. Deletes the schedule row.

### Design principles

- All game-specific data stored as JSON strings for schema stability
- Module enforces: session exists, player authorized, turn order. Game-specific rules are client-side.
- Use `SenderError` for user-caused errors (rolls back transaction cleanly)
- Timestamps in microseconds since epoch (ctx.timestamp gives this)
- Identity comparison uses `===`
- Insert with 0n for auto-increment primary keys

## Verification

After writing the code, run `spacetime build` from this directory (add SpacetimeDB to PATH: `$env:PATH += ";C:\Users\Rahul\AppData\Local\SpacetimeDB"`). Fix any type errors by consulting the actual `.d.ts` files in node_modules. Once it builds clean, publish with `spacetime publish stella-w08uu -s maincloud`.
