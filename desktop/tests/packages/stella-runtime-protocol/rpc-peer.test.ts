import { describe, expect, it, vi } from "vitest";
import {
  RPC_ERROR_CODES,
  type JsonRpcMessage,
} from "../../../packages/runtime-protocol/index.js";
import {
  JsonRpcPeer,
  RpcError,
} from "../../../packages/runtime-protocol/rpc-peer.js";

const connectPeers = () => {
  let left: JsonRpcPeer;
  let right: JsonRpcPeer;

  left = new JsonRpcPeer((message: JsonRpcMessage) => {
    void right.handleMessage(message);
  });
  right = new JsonRpcPeer((message: JsonRpcMessage) => {
    void left.handleMessage(message);
  });

  return { left, right };
};

describe("JsonRpcPeer", () => {
  it("routes requests and notifications across the transport boundary", async () => {
    const { left, right } = connectPeers();
    const notificationHandler = vi.fn();

    right.registerRequestHandler("math.add", ({ left, right }) => {
      return Number(left) + Number(right);
    });
    right.registerNotificationHandler("run.event", notificationHandler);

    left.notify("run.event", { seq: 1, type: "token" });
    await Promise.resolve();
    const result = await left.request<number>("math.add", { left: 2, right: 3 });

    expect(result).toBe(5);
    expect(notificationHandler).toHaveBeenCalledWith({ seq: 1, type: "token" });
  });

  it("returns typed RPC failures for unknown methods", async () => {
    const { left } = connectPeers();

    await expect(left.request("missing.method")).rejects.toMatchObject({
      code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      message: "Unknown method: missing.method",
    } satisfies Partial<RpcError>);
  });
});
