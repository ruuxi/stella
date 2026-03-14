/**
 * SpacetimeDB connection hook for game apps.
 *
 * Builds a DbConnectionBuilder configured for the Stella game module and
 * persists the reconnect token across refreshes.
 */

import { useMemo } from "react";
import { DbConnection } from "../bindings";
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
        .onConnect((_conn, identity, token) => {
          console.log(
            "[game] Connected to SpacetimeDB:",
            identity.toHexString(),
          );
          saveToken(token);
        })
        .onConnectError((_ctx, error) => {
          console.error("[game] Connection error:", error.message);
        })
        .onDisconnect((_ctx, error) => {
          if (error) {
            console.warn("[game] Disconnected with error:", error.message);
            return;
          }
          console.log("[game] Disconnected");
        }),
    [],
  );
}
