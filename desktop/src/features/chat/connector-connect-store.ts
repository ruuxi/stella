/**
 * Store for agent-initiated in-chat connect offers
 * (`connector-connect:request` from the main process, originating from
 * `stella-connect request-connection`). Chat surfaces render the head
 * of the queue as an inline connect card; accept/decline/cancel flow
 * back over the privileged `connector-connect:respond` IPC, and phase
 * updates stream in via `connector-connect:update`.
 *
 * The runtime agent is blocked on the CLI bridge while a card is
 * pending, so cards are inherently short-lived: they resolve (and the
 * conversation continues) or time out main-side.
 */

import { useSyncExternalStore } from "react";
import { getElectronApi } from "@/platform/electron/electron";

export type ConnectorConnectCardPhase =
  | "offer"
  | "connecting"
  | "connected"
  | "error";

export type ConnectorConnectCardRequest = {
  requestId: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
  /** "integration" (Store enable + OAuth) or "browser-extension" (Web Store install). */
  kind?: "integration" | "browser-extension";
  /** Owning chat; undefined = unscoped (legacy CLI path), shown everywhere. */
  conversationId?: string;
  phase: ConnectorConnectCardPhase;
  message?: string;
};

let queue: ConnectorConnectCardRequest[] = [];
const listeners = new Set<() => void>();
let initialized = false;

const CONNECTED_LINGER_MS = 3500;
const ERROR_LINGER_MS = 7000;

const emitChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const removeRequest = (requestId: string) => {
  if (!queue.some((entry) => entry.requestId === requestId)) return;
  queue = queue.filter((entry) => entry.requestId !== requestId);
  emitChange();
};

const initialize = () => {
  if (initialized) return;
  initialized = true;
  const systemApi = getElectronApi()?.system;
  if (
    !systemApi?.onConnectorConnectRequest ||
    !systemApi.onConnectorConnectUpdate
  ) {
    return;
  }
  systemApi.onConnectorConnectRequest((_event, data) => {
    if (queue.some((entry) => entry.requestId === data.requestId)) return;
    queue = [...queue, { ...data, phase: "offer" }];
    emitChange();
  });
  systemApi.onConnectorConnectUpdate((_event, data) => {
    const entry = queue.find((item) => item.requestId === data.requestId);
    if (!entry) return;
    if (
      data.phase === "declined" ||
      data.phase === "cancelled" ||
      data.phase === "timeout"
    ) {
      // The agent's own reply acknowledges these outcomes in the
      // thread; the card just goes away.
      removeRequest(data.requestId);
      return;
    }
    const phase: ConnectorConnectCardPhase =
      data.phase === "connecting"
        ? "connecting"
        : data.phase === "connected"
          ? "connected"
          : "error";
    queue = queue.map((item) =>
      item.requestId === data.requestId
        ? { ...item, phase, message: data.message }
        : item,
    );
    emitChange();
    if (data.phase === "connected" || data.phase === "error") {
      window.setTimeout(
        () => removeRequest(data.requestId),
        data.phase === "connected" ? CONNECTED_LINGER_MS : ERROR_LINGER_MS,
      );
    }
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  initialize();
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => queue;

/**
 * First connect offer visible to the given chat surface, or null. A card
 * scoped to a conversation renders only in that conversation's surfaces;
 * unscoped cards (no conversationId on the request) render everywhere.
 */
export const useConnectorConnectRequest = (
  conversationId?: string | null,
): ConnectorConnectCardRequest | null => {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    snapshot.find(
      (entry) =>
        !entry.conversationId ||
        !conversationId ||
        entry.conversationId === conversationId,
    ) ?? null
  );
};

export const respondToConnectorConnect = (
  requestId: string,
  action: "accept" | "decline" | "cancel",
) => {
  void getElectronApi()?.system.respondConnectorConnect({ requestId, action });
};
