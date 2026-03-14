---
id: multiplayer-game
name: Multiplayer Game
description: Build Stella multiplayer games on the shared realtime runtime. Use only for multiplayer or networked game work: creating or modifying hosted or workspace multiplayer game apps, wiring multiplayer game logic to sessions, players, entities, components, resources, events, input frames, private state, snapshots, or tick loops, and using the canonical runtime tables and reducers. Do not use for single-player, local-only, or mockup-only games.
agentTypes:
  - self_mod
tags:
  - game
  - spacetimedb
  - multiplayer
  - workspace
  - self-mod
version: 1
---

# Multiplayer Game

Build new Stella multiplayer games on the existing runtime first. Only change the runtime itself when the current primitives truly cannot express the multiplayer game.

## Read First

Before editing, read these files:
- `spacetimedb/src/index.ts`
- `desktop/src/features/games/bindings/index.ts`
- `desktop/templates/workspace-game-app/src/App.tsx`
- `desktop/templates/workspace-game-app/src/components/Lobby.tsx`
- `desktop/templates/workspace-game-app/src/hooks/useSpacetime.ts`
- `desktop/templates/workspace-game-app/src/lib/session.ts`
- `desktop/scripts/create-workspace-app.mjs`

## Scope

Use this skill only for multiplayer or networked games.

Do not use this skill for:
- single-player games
- local-only prototypes with no networking
- static game mockups
- non-game workspace apps

For those, use the regular `workspace` and `self-modification` flows instead.

## Two Modes

### 1. Create or update a game app

Use this for almost all multiplayer requests like "make me a multiplayer trivia game" or "turn this into a co-op action game."

Workflow:
1. Scaffold a new game app or update an existing one:
   `Bash(command="cd desktop && node scripts/create-workspace-app.mjs my-game --template game --spacetimedb-module stella-w08uu")`
2. Build the game in `desktop/workspace/apps/<name>/src/`.
3. Use the generated Spacetime bindings inside that app.
4. Keep subscriptions scoped with `useTable(tables.foo.where(...))`.
5. Use reducers like `createSession`, `joinSession`, `startSession`, `submitInputFrame`, `spawnEntity`, `upsertEntityComponent`, `emitSessionEvent`, `startTickLoop`.

### 2. Evolve the shared runtime

Do this only when the game needs a new primitive that cannot be expressed with the current runtime.

Workflow:
1. Edit `spacetimedb/src/index.ts`
2. Run `spacetime build`
3. Run `spacetime generate --lang typescript --out-dir ../desktop/src/features/games/bindings --module-path . --yes`
4. Update desktop and template consumers if the surface changed
5. Publish the module

## Canonical Runtime

The current runtime is built around these primitives:
- `sessions`: lobby, phase, runtime config, authoritative tick state
- `players`: roster, slot, team, role, pawn binding, presence, score
- `entities`: world objects and transforms
- `entity_components`: arbitrary typed data attached to entities
- `session_resources`: shared game state
- `session_events`: authoritative outcomes and notable events
- `input_frames`: per-player realtime inputs
- `my_private_state`: sender-filtered hidden state
- internal snapshots and tick schedules for rewind and authoritative ticking

This runtime supports:
- turn-based games
- card and board games
- trivia, drawing, party, social deduction
- top-down action, racing, RPG, and physics-lite games
- FPS-style data flow primitives

Important: FPS feel still requires client-side prediction, interpolation, and reconciliation in the generated game app. The runtime gives you authoritative state, snapshots, and input streams, not automatic shooter feel.

## Runtime Reference

Use these primitives as the source of truth for multiplayer game design:

### Tables

Public tables:
- `sessions`
  - one row per match or lobby
  - includes `gameId`, `joinCode`, `lifecycleState`, `phaseKey`, `runtimeKind`, `rulesetKey`, `minPlayers`, `maxPlayers`, `activeTurnSlot`, `simulationTick`, `tickRateHz`, `snapshotRateHz`, `interestMode`, `partitionSize`, `publicStateJson`, `metadataJson`
- `players`
  - one row per player in a session
  - includes `slot`, `teamId`, `roleKey`, `pawnEntityId`, `score`, `lifecycleState`, `isHost`, `presenceJson`, `lastInputSeq`
- `entities`
  - canonical world objects with transform, velocity, authority, zone, replication, and visibility fields
- `entity_components`
  - arbitrary typed data attached to entities
  - includes `componentName`, `schemaKey`, `replicationGroup`, `visibilityScope`, `visibilityKey`, `ownerSlot`, `dataJson`
- `session_resources`
  - shared or global game state chunks
- `session_events`
  - append-only authoritative outcomes
- `input_frames`
  - realtime per-player inputs
- `my_private_state`
  - sender-filtered hidden state rows

Internal tables:
- `player_private_state`
- `entity_snapshots`
- `tick_schedules`
- `auth_registrations`
- `used_game_tokens`

### Reducers

Auth and session lifecycle:
- `registerPlayer`
- `createSession`
- `joinSession`
- `leaveSession`
- `startSession`
- `pauseSession`
- `resumeSession`
- `endSession`
- `configureSessionRuntime`
- `updateSessionState`

Entities and state:
- `spawnEntity`
- `updateEntityTransform`
- `despawnEntity`
- `upsertEntityComponent`
- `removeEntityComponent`
- `upsertSessionResource`
- `removeSessionResource`
- `emitSessionEvent`

Players and hidden state:
- `assignPlayerPawn`
- `updatePlayerPresence`
- `adjustPlayerScore`
- `upsertPrivateState`
- `removePrivateState`

Realtime simulation:
- `submitInputFrame`
- `captureSnapshot`
- `pruneSnapshots`
- `startTickLoop`
- `stopTickLoop`

### Recommended Mapping By Genre

Board, card, and turn-based games:
- `sessions.publicStateJson` for phase and ruleset state
- `players` for slots, teams, score, and role
- `entities` for pieces, cards, board objects, and interactables
- `entity_components` for per-entity details
- `my_private_state` for hands, hidden roles, and fog-of-war

Party and social games:
- `session_resources` for decks, prompts, voting state, and team assignments
- `session_events` for guesses, votes, reveals, and scoring outcomes
- `my_private_state` for secret prompts, answers, or roles

Action and simulation games:
- `entities` for bodies, projectiles, pickups, and NPCs
- `entity_components` for health, inventory, weapons, AI state, colliders, and status effects
- `input_frames` for movement, aim, fire, interaction, and abilities
- `session_events` for authoritative outcomes
- snapshots and ticks for rewind, lag compensation, and replayable state

### Interest and Visibility

Use these fields deliberately:
- `zoneKey`: spatial or logical partition like `sector:3:4`, `room:bridge`, `table:center`
- `replicationGroup`: stream separation like `world`, `combat`, `ui`, `team:red`
- `visibilityScope`: `public`, `owner`, `team`, `role`, or another explicit convention your game enforces
- `visibilityKey`: the team, role, or custom audience key for scoped replication

## Code Patterns

### Hosted Game Auth

Hosted and workspace multiplayer games do not bootstrap with raw session JWTs.

They receive a brokered launch message from Stella:

```ts
window.addEventListener("message", (event) => {
  if (event.data?.type === "stella:game-auth") {
    saveHostedLaunchAuth(event.data);
  }
});
```

Then register with the runtime:

```ts
await registerPlayer({ gameToken: launchAuth.gameToken });
```

Scaffold a new multiplayer game app:

```bash
cd desktop
node scripts/create-workspace-app.mjs arena-duel --template game --spacetimedb-module stella-w08uu
```

Create and start a session:

```ts
await createSession({
  gameType: "arena-duel",
  rulesetKey: "default",
  minPlayers: 2,
  maxPlayers: 8,
  runtimeKind: "authoritative",
  tickRateHz: 20,
  snapshotRateHz: 20,
  interestMode: "session",
  partitionSize: 32,
  publicStateJson: "{}",
  metadataJson: "{}",
});

await startSession({ sessionId });
await startTickLoop({ sessionId });
```

## Query Pattern

Always prefer scoped queries:

```ts
const [players] = useTable(
  tables.players.where((row) => row.sessionId.eq(sessionId)),
);
```

Not this:

```ts
connection.subscriptionBuilder().subscribe([tables.players]);
```

More scoped examples:

```ts
const [sessionRows] = useTable(
  tables.sessions.where((row) => row.sessionId.eq(sessionId)),
);

const [entities] = useTable(
  tables.entities.where((row) => row.sessionId.eq(sessionId)),
);
```

Join a session from a join code:

```ts
await joinSession({
  joinCode: code.trim().toUpperCase(),
});
```

Spawn a player pawn:

```ts
await spawnEntity({
  sessionId,
  entityKey: `player:${slot}`,
  archetype: "player-pawn",
  ownerSlot: slot,
  authority: "owner",
  replicationGroup: "world",
  zoneKey: "arena:0:0",
  visibilityScope: "public",
  x: 0,
  y: 0,
  z: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  sx: 1,
  sy: 1,
  sz: 1,
  vx: 0,
  vy: 0,
  vz: 0,
  simulationTick: 0,
  lifecycleState: "active",
  stateJson: JSON.stringify({ hp: 100 }),
});
```

Attach an entity component:

```ts
await upsertEntityComponent({
  sessionId,
  entityId,
  componentName: "weapon",
  schemaKey: "weapon.v1",
  replicationGroup: "combat",
  visibilityScope: "public",
  ownerSlot: slot,
  dataJson: JSON.stringify({
    kind: "blaster",
    ammo: 24,
    cooldownMs: 250,
  }),
});
```

Submit realtime input:

```ts
await submitInputFrame({
  sessionId,
  inputSeq,
  clientTick,
  inputKind: "frame",
  inputJson: JSON.stringify({
    moveX,
    moveY,
    aimX,
    aimY,
    firing,
  }),
});
```

Emit an authoritative outcome:

```ts
await emitSessionEvent({
  sessionId,
  eventKind: "damage.applied",
  eventScope: "combat",
  replicationGroup: "combat",
  visibilityScope: "public",
  simulationTick,
  dataJson: JSON.stringify({
    sourceEntityId,
    targetEntityId,
    amount: 12,
  }),
});
```

Write hidden state:

```ts
await upsertPrivateState({
  sessionId,
  stateKey: "hand",
  stateJson: JSON.stringify({
    cards: ["7H", "AC", "JD"],
  }),
});
```

Decode the hosted game token for scoped subscriptions:

```ts
const launchContext = decodeHostedGameToken(launchAuth.gameToken);
const gameId = launchContext?.gameId ?? "__stella:no-game__";

const [sessions] = useTable(
  tables.sessions.where((row) => row.gameId.eq(gameId)),
);
```

## Game-Building Checklist

When creating a new game:
1. Decide whether the game fits the current primitives
2. Scaffold from the `game` workspace template
3. Keep lobby and auth flow intact unless intentionally redesigning it
4. Model gameplay with `entities`, `entity_components`, `session_resources`, `session_events`, and `input_frames`
5. Use `startTickLoop` only for authoritative ticking, timers, and simulation
6. Keep hidden info in `upsertPrivateState` and `my_private_state`
7. Run the relevant build or lint step after edits

Only change the shared runtime when:
- you need a new primitive shared by many games
- the current runtime cannot model the data cleanly
- multiple games are repeating the same workaround

Do not change the shared runtime when:
- you only need a different JSON shape
- the game can be expressed with entities, components, resources, events, and private state
- you are reaching for genre-specific tables or reducers instead of the shared multiplayer primitives

## Verification

For runtime changes:
- `cd spacetimedb && spacetime build`
- regenerate desktop bindings

For desktop or template changes:
- run targeted `eslint` or the relevant project check
