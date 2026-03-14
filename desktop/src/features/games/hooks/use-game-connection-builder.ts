import { useMemo } from "react";
import { DbConnection, tables } from "@/features/games/bindings";
import {
  SPACETIMEDB_DATABASE,
  SPACETIMEDB_URI,
  getSavedSpacetimeToken,
  saveSpacetimeToken,
} from "@/features/games/lib/connection";

export function useGameConnectionBuilder() {
  return useMemo(
    () =>
      DbConnection.builder()
        .withUri(SPACETIMEDB_URI)
        .withDatabaseName(SPACETIMEDB_DATABASE)
        .withToken(getSavedSpacetimeToken())
        .onConnect((connection, identity, token) => {
          saveSpacetimeToken(token);
          connection.subscriptionBuilder().subscribe([
            tables.game_sessions,
            tables.game_players,
            tables.game_objects,
            tables.game_actions,
            tables.game_chat,
            tables.my_private_state,
          ]);
          console.debug(
            "[games] Connected to SpacetimeDB as",
            identity.toHexString(),
          );
        })
        .onConnectError((_ctx, error) => {
          console.warn("[games] SpacetimeDB connect failed:", error.message);
        })
        .onDisconnect((_ctx, error) => {
          if (error) {
            console.warn(
              "[games] SpacetimeDB disconnected with error:",
              error.message,
            );
            return;
          }
          console.debug("[games] SpacetimeDB disconnected");
        }),
    [],
  );
}
