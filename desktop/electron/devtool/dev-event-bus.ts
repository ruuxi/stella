/**
 * Dev-mode event bus for the standalone devtool.
 *
 * Lives in the Electron main process. Agent handlers, IPC, and other
 * subsystems push events here; the WebSocket debug server subscribes
 * and forwards them to the devtool client.
 */

export type DevEventType =
  | "agent-event"
  | "ipc-call";

export type DevEvent = {
  type: DevEventType;
  ts: number;
  payload: unknown;
};

type DevEventListener = (event: DevEvent) => void;

const listeners = new Set<DevEventListener>();

export const devEventBus = {
  emit(type: DevEventType, payload: unknown) {
    const event: DevEvent = { type, ts: Date.now(), payload };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // never let a listener crash the main process
      }
    }
  },

  subscribe(listener: DevEventListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  get listenerCount() {
    return listeners.size;
  },
};
