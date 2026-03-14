import { useMemo } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@/features/games/bindings";
import type {
  GameActions,
  GameChat,
  GameObjects,
  GamePlayers,
  GameSessions,
  MyPrivateStateRow,
} from "@/features/games/bindings/types";

type SessionScopedRuntime = {
  session: GameSessions | null;
  players: GamePlayers[];
  myPlayer: GamePlayers | null;
  objects: GameObjects[];
  actions: GameActions[];
  chat: GameChat[];
  privateState: MyPrivateStateRow[];
};

export function useStellaGameRuntime(sessionId?: bigint | null) {
  const connection = useSpacetimeDB();
  const [sessions, sessionsReady] = useTable(tables.game_sessions);
  const [players, playersReady] = useTable(tables.game_players);
  const [objects, objectsReady] = useTable(tables.game_objects);
  const [actions, actionsReady] = useTable(tables.game_actions);
  const [chat, chatReady] = useTable(tables.game_chat);
  const [privateState, privateStateReady] = useTable(tables.my_private_state);

  return useMemo(() => {
    const session =
      sessionId == null
        ? null
        : sessions.find((candidate) => candidate.sessionId === sessionId) ?? null;

    const sessionScoped: SessionScopedRuntime = {
      session,
      players:
        sessionId == null
          ? []
          : players.filter((player) => player.sessionId === sessionId),
      myPlayer:
        sessionId == null || !connection.identity
          ? null
          : players.find(
              (player) =>
                player.sessionId === sessionId &&
                player.playerIdentity.isEqual(connection.identity),
            ) ?? null,
      objects:
        sessionId == null
          ? []
          : objects.filter((gameObject) => gameObject.sessionId === sessionId),
      actions:
        sessionId == null
          ? []
          : actions.filter((gameAction) => gameAction.sessionId === sessionId),
      chat:
        sessionId == null
          ? []
          : chat.filter((chatMessage) => chatMessage.sessionId === sessionId),
      privateState:
        sessionId == null
          ? []
          : privateState.filter((row) => row.sessionId === sessionId),
    };

    return {
      connection,
      readiness: {
        sessions: sessionsReady,
        players: playersReady,
        objects: objectsReady,
        actions: actionsReady,
        chat: chatReady,
        privateState: privateStateReady,
        all:
          sessionsReady &&
          playersReady &&
          objectsReady &&
          actionsReady &&
          chatReady &&
          privateStateReady,
      },
      sessions,
      players,
      objects,
      actions,
      chat,
      privateState,
      current: sessionScoped,
    };
  }, [
    actions,
    actionsReady,
    chat,
    chatReady,
    connection,
    objects,
    objectsReady,
    players,
    playersReady,
    privateState,
    privateStateReady,
    sessionId,
    sessions,
    sessionsReady,
  ]);
}
