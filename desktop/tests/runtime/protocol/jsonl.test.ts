import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { RPC_ERROR_CODES } from "../../../../runtime/protocol/index.js";
import { attachJsonRpcPeerToStreams } from "../../../../runtime/protocol/jsonl.js";

const waitForEvent = (stream: EventEmitter, eventName: string) =>
  new Promise<void>((resolve) => {
    stream.once(eventName, () => resolve());
  });

describe("attachJsonRpcPeerToStreams", () => {
  it("rejects requests instead of writing after the output stream ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onError = vi.fn();
    const { peer, dispose } = attachJsonRpcPeerToStreams({
      input,
      output,
      onError,
    });

    output.end();
    await waitForEvent(output, "finish");

    await expect(peer.request("runtime.test")).rejects.toMatchObject({
      code: RPC_ERROR_CODES.RUNTIME_UNAVAILABLE,
    });
    expect(onError).not.toHaveBeenCalled();

    dispose();
    input.destroy();
    output.destroy();
  });
});
