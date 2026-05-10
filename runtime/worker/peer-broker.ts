import {
  RPC_ERROR_CODES,
  type JsonRpcMessage,
} from "../protocol/index.js";
import {
  JsonRpcPeer,
  RpcError,
  type JsonRpcPeer as JsonRpcPeerInstance,
} from "../protocol/rpc-peer.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => Promise<void> | void;

/**
 * Minimal surface shared by `JsonRpcPeer` and `WorkerPeerBroker`. All
 * server-side helpers (notifyLocalChatUpdated, dispatchApplyBatch, etc.)
 * type their `peer` param against this so both single-peer (legacy
 * stdio embed, tests) and multi-peer (detached UDS) wiring work
 * without any code-site changes.
 */
export type WorkerPeerLike = {
  notify: (method: string, params?: unknown) => void;
  request: <TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { retryOnDisconnect?: boolean },
  ) => Promise<TResult>;
  registerRequestHandler: (method: string, handler: RequestHandler) => void;
  registerNotificationHandler: (
    method: string,
    handler: NotificationHandler,
  ) => void;
  activeRequestHandlerCount?: () => number;
};

type PeerEvents = {
  "client-attached": void;
  "client-detached": void;
};

type PeerEventListener<K extends keyof PeerEvents> = (
  payload: PeerEvents[K],
) => void;

const NO_HOST_TIMEOUT_MS = 30_000;

/**
 * The worker's view of "the host." The runtime worker is conceptually
 * single-stream JSON-RPC, but with a detached process model we need to
 * cleanly hand off the connection across host restarts: the previous
 * Electron process dies → its stdio (or UDS) connection drops → a new
 * Electron starts and reattaches to the still-running worker.
 *
 * `WorkerPeerBroker` is the indirection that makes that handoff
 * transparent to the rest of `server.ts`. Internally it keeps a list of
 * attached peers (in attach-order) but always treats the most-recently
 * attached peer as authoritative for outgoing requests. Notifications
 * fan out to every attached peer so a transient observer (e.g. the
 * eventual `stella` CLI) can subscribe alongside Electron.
 *
 * Single-peer-at-a-time today is sufficient for Stella's topology
 * (one Electron host); the multi-attach surface is here so the future
 * "two clients during a brief overlap window" case (host A about to
 * exit while host B is establishing) doesn't drop notifications mid-flight.
 */
export class WorkerPeerBroker {
  private readonly attachedPeers = new Set<JsonRpcPeer>();
  private readonly attachOrder: JsonRpcPeer[] = [];
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private readonly listeners = new Map<
    keyof PeerEvents,
    Set<PeerEventListener<keyof PeerEvents>>
  >();
  private waitForPeerResolvers: Array<() => void> = [];
  private activeRequestHandlers = 0;

  attach(peer: JsonRpcPeer) {
    this.attachedPeers.add(peer);
    this.attachOrder.push(peer);
    for (const [method, handler] of this.requestHandlers) {
      peer.registerRequestHandler(method, handler);
    }
    for (const [method, handler] of this.notificationHandlers) {
      peer.registerNotificationHandler(method, handler);
    }
    peer.on("closed", () => {
      this.detach(peer);
    });
    const resolvers = this.waitForPeerResolvers;
    this.waitForPeerResolvers = [];
    for (const resolve of resolvers) resolve();
    this.emit("client-attached", undefined);
  }

  detach(peer: JsonRpcPeer) {
    if (!this.attachedPeers.delete(peer)) return;
    const idx = this.attachOrder.indexOf(peer);
    if (idx >= 0) this.attachOrder.splice(idx, 1);
    this.emit("client-detached", undefined);
  }

  attachedCount(): number {
    return this.attachedPeers.size;
  }

  activeRequestHandlerCount(): number {
    return this.activeRequestHandlers;
  }

  on<K extends keyof PeerEvents>(
    eventName: K,
    listener: PeerEventListener<K>,
  ): () => void {
    let bucket = this.listeners.get(eventName);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(eventName, bucket);
    }
    bucket.add(listener as PeerEventListener<keyof PeerEvents>);
    return () => {
      bucket?.delete(listener as PeerEventListener<keyof PeerEvents>);
    };
  }

  private emit<K extends keyof PeerEvents>(
    eventName: K,
    payload: PeerEvents[K],
  ) {
    const bucket = this.listeners.get(eventName);
    if (!bucket) return;
    for (const listener of bucket) {
      try {
        (listener as PeerEventListener<K>)(payload);
      } catch {
        // Listener errors are isolated.
      }
    }
  }

  registerRequestHandler(method: string, handler: RequestHandler) {
    const wrappedHandler: RequestHandler = async (params) => {
      this.activeRequestHandlers += 1;
      try {
        return await handler(params);
      } finally {
        this.activeRequestHandlers = Math.max(0, this.activeRequestHandlers - 1);
      }
    };
    this.requestHandlers.set(method, wrappedHandler);
    for (const peer of this.attachedPeers) {
      peer.registerRequestHandler(method, wrappedHandler);
    }
  }

  registerNotificationHandler(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
    for (const peer of this.attachedPeers) {
      peer.registerNotificationHandler(method, handler);
    }
  }

  /**
   * Fan-out notification: every attached peer hears the event.
   */
  notify(method: string, params?: unknown) {
    for (const peer of this.attachedPeers) {
      try {
        peer.notify(method, params);
      } catch {
        // Notification failures on one peer don't block the rest.
      }
    }
  }

  /**
   * Outgoing request to "the host." We pick the most-recently attached
   * peer as authoritative; if no peer is attached, wait briefly for one.
   * Mid-call disconnect retries are opt-in because most host callbacks
   * should fail quickly during bootstrap or tool work. Morph transitions
   * opt in because they are specifically meant to bridge an Electron
   * restart gap.
   */
  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: { retryOnDisconnect?: boolean },
  ): Promise<TResult> {
    const deadline = Date.now() + NO_HOST_TIMEOUT_MS;
    while (true) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const peer = this.pickPeer() ?? (await this.waitForPeer(remainingMs));
      try {
        return await peer.request<TResult>(method, params);
      } catch (error) {
        const detached = !this.attachedPeers.has(peer);
        const disposed =
          error instanceof RpcError &&
          error.code === RPC_ERROR_CODES.INTERNAL_ERROR &&
          error.message === "RPC peer disposed.";
        if (
          options?.retryOnDisconnect !== true ||
          (!detached && !disposed) ||
          Date.now() >= deadline
        ) {
          throw error;
        }
      }
    }
  }

  private pickPeer(): JsonRpcPeer | null {
    for (let i = this.attachOrder.length - 1; i >= 0; i -= 1) {
      const peer = this.attachOrder[i];
      if (peer && this.attachedPeers.has(peer)) {
        return peer;
      }
    }
    return null;
  }

  private waitForPeer(timeoutMs: number): Promise<JsonRpcPeer> {
    return new Promise<JsonRpcPeer>((resolve, reject) => {
      const onAttach = () => {
        clearTimeout(timer);
        const peer = this.pickPeer();
        if (peer) {
          resolve(peer);
        } else {
          // Race: someone detached before we resolved. Re-queue.
          this.waitForPeerResolvers.push(onAttach);
        }
      };
      const timer = setTimeout(() => {
        const idx = this.waitForPeerResolvers.indexOf(onAttach);
        if (idx >= 0) this.waitForPeerResolvers.splice(idx, 1);
        reject(
          new RpcError(
            RPC_ERROR_CODES.RUNTIME_UNAVAILABLE,
            "No host connected to receive RPC request.",
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.waitForPeerResolvers.push(onAttach);
    });
  }

  /**
   * Tear down every attached peer. Called during worker shutdown so
   * pending RPCs reject instead of timing out individually.
   */
  dispose() {
    const peers = [...this.attachedPeers];
    this.attachedPeers.clear();
    this.attachOrder.length = 0;
    for (const peer of peers) {
      try {
        peer.dispose();
      } catch {
        // Best effort.
      }
    }
  }
}

export type { JsonRpcPeerInstance, JsonRpcMessage };
