import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../../../packages/runtime-protocol/rpc-peer.js";

describe("JsonRpcPeer", () => {
  it("serializes undefined request results as null", async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer((message) => {
      sent.push(message);
    });

    peer.registerRequestHandler("test.undefined", async () => undefined);

    await peer.handleMessage({
      id: 1,
      method: "test.undefined",
    });

    expect(sent).toEqual([{ id: 1, result: null }]);
  });
});
