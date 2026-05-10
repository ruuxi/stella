import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "../../../../runtime/protocol/rpc-peer.js";
import { WorkerPeerBroker } from "../../../../runtime/worker/peer-broker.js";

/**
 * Wires two `JsonRpcPeer` instances together over a microtask-queued
 * loopback so request/response and notification semantics work without
 * spawning a real transport. Mirrors a UDS hop minus the byte stream.
 */
const createConnectedPair = () => {
  const peerA: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => peerB.handleMessage(message));
  });
  const peerB: JsonRpcPeer = new JsonRpcPeer((message) => {
    queueMicrotask(() => peerA.handleMessage(message));
  });
  return { peerA, peerB };
};

describe("WorkerPeerBroker", () => {
  it("fans out notifications to every attached peer", async () => {
    const broker = new WorkerPeerBroker();
    const { peerA, peerB } = createConnectedPair();
    const { peerA: peerC, peerB: peerD } = createConnectedPair();

    const seenA: unknown[] = [];
    const seenC: unknown[] = [];
    peerB.registerNotificationHandler("ping", (params) => {
      seenA.push(params);
    });
    peerD.registerNotificationHandler("ping", (params) => {
      seenC.push(params);
    });

    broker.attach(peerA);
    broker.attach(peerC);
    broker.notify("ping", { n: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seenA).toEqual([{ n: 1 }]);
    expect(seenC).toEqual([{ n: 1 }]);
  });

  it("registers handlers on currently-attached and future-attached peers", async () => {
    const broker = new WorkerPeerBroker();
    const handler = vi.fn(async () => "ok");
    broker.registerRequestHandler("echo", handler);

    const { peerA, peerB } = createConnectedPair();
    broker.attach(peerA);

    const result = await peerB.request("echo", { hello: "world" });
    expect(result).toBe("ok");
    expect(handler).toHaveBeenCalledWith({ hello: "world" });
  });

  it("routes outgoing requests to the most-recently attached peer", async () => {
    const broker = new WorkerPeerBroker();
    const { peerA, peerB } = createConnectedPair();
    const { peerA: peerC, peerB: peerD } = createConnectedPair();

    peerB.registerRequestHandler("who", async () => "first");
    peerD.registerRequestHandler("who", async () => "second");

    broker.attach(peerA);
    broker.attach(peerC);

    const result = await broker.request<string>("who");
    expect(result).toBe("second");
  });

  it("falls back to a previously attached peer after the latest detaches", async () => {
    const broker = new WorkerPeerBroker();
    const { peerA, peerB } = createConnectedPair();
    const { peerA: peerC, peerB: peerD } = createConnectedPair();

    peerB.registerRequestHandler("who", async () => "first");
    peerD.registerRequestHandler("who", async () => "second");

    broker.attach(peerA);
    broker.attach(peerC);
    broker.detach(peerC);

    const result = await broker.request<string>("who");
    expect(result).toBe("first");
  });

  it("retries an outgoing request on the next peer when the current peer detaches mid-flight", async () => {
    const broker = new WorkerPeerBroker();
    const { peerA, peerB } = createConnectedPair();
    const { peerA: peerC, peerB: peerD } = createConnectedPair();

    peerB.registerRequestHandler(
      "who",
      async () =>
        await new Promise<string>((resolve) => {
          setTimeout(() => resolve("first"), 25);
        }),
    );
    peerD.registerRequestHandler("who", async () => "second");

    broker.attach(peerA);
    const resultPromise = broker.request<string>("who", undefined, {
      retryOnDisconnect: true,
    });
    peerA.dispose();
    broker.attach(peerC);

    await expect(resultPromise).resolves.toBe("second");
  });

  it("fires client-attached and client-detached events", () => {
    const broker = new WorkerPeerBroker();
    const events: string[] = [];
    broker.on("client-attached", () => events.push("attached"));
    broker.on("client-detached", () => events.push("detached"));

    const { peerA } = createConnectedPair();
    broker.attach(peerA);
    broker.detach(peerA);

    expect(events).toEqual(["attached", "detached"]);
  });
});
