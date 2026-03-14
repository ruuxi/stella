import { useMemo } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@/features/games/bindings";
import type {
  Entities,
  EntityComponents,
  InputFrames,
  MyPrivateStateRow,
  Players,
  SessionEvents,
  SessionResources,
  Sessions,
} from "@/features/games/bindings/types";

const NO_SESSION_GAME_ID = "__stella:no-session__";
const NO_SESSION_USER_ID = "__stella:no-session__";
const NO_SESSION_ENTITY_KEY = "__stella:no-session__";
const NO_SESSION_COMPONENT_NAME = "__stella:no-session__";
const NO_SESSION_INPUT_KIND = "__stella:no-session__";
const NO_SESSION_RESOURCE_KEY = "__stella:no-session__";
const NO_SESSION_EVENT_KIND = "__stella:no-session__";
const NO_SESSION_STATE_KEY = "__stella:no-session__";

type SessionScopedRuntime = {
  session: Sessions | null;
  players: readonly Players[];
  myPlayer: Players | null;
  entities: readonly Entities[];
  components: readonly EntityComponents[];
  inputs: readonly InputFrames[];
  resources: readonly SessionResources[];
  events: readonly SessionEvents[];
  privateState: readonly MyPrivateStateRow[];
};

export function useStellaGameRuntime(sessionId?: bigint | null) {
  const connection = useSpacetimeDB();
  const [sessions, sessionsReady] = useTable(
    sessionId == null
      ? tables.sessions.where((row) => row.gameId.eq(NO_SESSION_GAME_ID))
      : tables.sessions.where((row) => row.sessionId.eq(sessionId)),
  );
  const [players, playersReady] = useTable(
    sessionId == null
      ? tables.players.where((row) => row.userId.eq(NO_SESSION_USER_ID))
      : tables.players.where((row) => row.sessionId.eq(sessionId)),
  );
  const [entities, entitiesReady] = useTable(
    sessionId == null
      ? tables.entities.where((row) => row.entityKey.eq(NO_SESSION_ENTITY_KEY))
      : tables.entities.where((row) => row.sessionId.eq(sessionId)),
  );
  const [components, componentsReady] = useTable(
    sessionId == null
      ? tables.entity_components.where((row) =>
          row.componentName.eq(NO_SESSION_COMPONENT_NAME),
        )
      : tables.entity_components.where((row) => row.sessionId.eq(sessionId)),
  );
  const [inputs, inputsReady] = useTable(
    sessionId == null
      ? tables.input_frames.where((row) => row.inputKind.eq(NO_SESSION_INPUT_KIND))
      : tables.input_frames.where((row) => row.sessionId.eq(sessionId)),
  );
  const [resources, resourcesReady] = useTable(
    sessionId == null
      ? tables.session_resources.where((row) =>
          row.resourceKey.eq(NO_SESSION_RESOURCE_KEY),
        )
      : tables.session_resources.where((row) => row.sessionId.eq(sessionId)),
  );
  const [events, eventsReady] = useTable(
    sessionId == null
      ? tables.session_events.where((row) => row.eventKind.eq(NO_SESSION_EVENT_KIND))
      : tables.session_events.where((row) => row.sessionId.eq(sessionId)),
  );
  const [privateState, privateStateReady] = useTable(
    sessionId == null
      ? tables.my_private_state.where((row) => row.stateKey.eq(NO_SESSION_STATE_KEY))
      : tables.my_private_state.where((row) => row.sessionId.eq(sessionId)),
  );

  return useMemo(() => {
    const session = sessions[0] ?? null;
    const myPlayer =
      sessionId == null || !connection.identity
        ? null
        : players.find((player) =>
            player.playerIdentity.isEqual(connection.identity),
          ) ?? null;

    const current: SessionScopedRuntime = {
      session,
      players,
      myPlayer,
      entities,
      components,
      inputs,
      resources,
      events,
      privateState,
    };

    return {
      connection,
      readiness: {
        sessions: sessionsReady,
        players: playersReady,
        entities: entitiesReady,
        components: componentsReady,
        inputs: inputsReady,
        resources: resourcesReady,
        events: eventsReady,
        privateState: privateStateReady,
        all:
          sessionsReady &&
          playersReady &&
          entitiesReady &&
          componentsReady &&
          inputsReady &&
          resourcesReady &&
          eventsReady &&
          privateStateReady,
      },
      sessions,
      players,
      entities,
      components,
      inputs,
      resources,
      events,
      privateState,
      current,
    };
  }, [
    components,
    componentsReady,
    connection,
    entities,
    entitiesReady,
    events,
    eventsReady,
    inputs,
    inputsReady,
    players,
    playersReady,
    privateState,
    privateStateReady,
    resources,
    resourcesReady,
    sessionId,
    sessions,
    sessionsReady,
  ]);
}
