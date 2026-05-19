import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./index.js";
import { createRuntimeUnavailableError, JsonRpcPeer } from "./rpc-peer.js";

export const attachJsonRpcPeerToStreams = (args: {
  input: Readable;
  output: Writable;
  requestTimeoutMs?: number;
  onError?: (error: unknown) => void;
}) => {
  let closed = false;

  const closePeer = (reason?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    rpcPeer.dispose(
      reason ??
        createRuntimeUnavailableError("Runtime RPC transport is closed."),
    );
  };

  const ensureWritable = () => {
    if (closed || args.output.destroyed || args.output.writableEnded) {
      const error = createRuntimeUnavailableError(
        "Runtime RPC transport is closed.",
      );
      closePeer(error);
      throw error;
    }
  };

  const rpcPeer = new JsonRpcPeer(
    (message) => {
      ensureWritable();
      args.output.write(`${JSON.stringify(message)}\n`);
    },
    {
      requestTimeoutMs: args.requestTimeoutMs,
      onError: args.onError,
    },
  );

  const lineReader = readline.createInterface({
    input: args.input,
    crlfDelay: Infinity,
  });

  const handleOutputError = (error: unknown) => {
    args.onError?.(error);
    closePeer(error);
  };
  const handleOutputClosed = () => {
    closePeer(createRuntimeUnavailableError("Runtime RPC transport is closed."));
  };

  args.output.on("error", handleOutputError);
  args.output.on("close", handleOutputClosed);

  lineReader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      args.onError?.(error);
      return;
    }
    void rpcPeer.handleMessage(message);
  });

  lineReader.on("close", () => {
    closePeer(createRuntimeUnavailableError("Runtime RPC transport is closed."));
  });

  return {
    peer: rpcPeer,
    dispose: () => {
      args.output.off("error", handleOutputError);
      args.output.off("close", handleOutputClosed);
      lineReader.close();
      closePeer();
    },
  };
};
