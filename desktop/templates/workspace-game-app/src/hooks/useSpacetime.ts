/**
 * SpacetimeDB connection hook for game apps.
 *
 * Builds a DbConnectionBuilder configured for the Stella game module.
 * Saves the auth token to localStorage for reconnection.
 *
 * Usage:
 *   const builder = useGameConnectionBuilder();
 *   // Pass to <SpacetimeDBProvider connectionBuilder={builder}>
 */

import { useMemo } from "react";
// NOTE: DbConnection and tables are imported from generated bindings.
// Run `npm run generate` after deploying the SpacetimeDB module.
import { DbConnection, tables } from "../bindings";
import {
  SPACETIMEDB_HOST,
  SPACETIMEDB_MODULE,
  getSavedToken,
  saveToken,
} from "../lib/connection";

export function useGameConnectionBuilder() {
  return useMemo(
    () =>
      DbConnection.builder()
        .withUri(SPACETIMEDB_HOST)
        .withDatabaseName(SPACETIMEDB_MODULE)
        .withToken(getSavedToken())
        .onConnect((conn, identity, token) => {
          console.log(
            "[game] Connected to SpacetimeDB:",
            identity.toHexString(),
          );
          saveToken(token);

          // Subscribe to all game tables for the active session
          conn
            .subscriptionBuilder()
            .subscribe(tables.gameSessions)
            .subscribe(tables.gamePlayers)
            .subscribe(tables.gameObjects)
            .subscribe(tables.gameActions)
            .subscribe(tables.gameChat);
        })
        .onConnectError((_ctx, error) => {
          console.error("[game] Connection error:", error.message);
        })
        .onDisconnect((_ctx, error) => {
          if (error) {
            console.warn("[game] Disconnected with error:", error.message);
          } else {
            console.log("[game] Disconnected");
          }
        }),
    [],
  );
}
