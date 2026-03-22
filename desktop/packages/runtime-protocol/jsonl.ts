import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./index.js";
import { JsonRpcPeer } from "./rpc-peer.js";

export const attachJsonRpcPeerToStreams = (args: {
  input: Readable;
  output: Writable;
  requestTimeoutMs?: number;
  onError?: (error: unknown) => void;
}) => {
  const peer = new JsonRpcPeer(
    (message) => {
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
    void peer.handleMessage(message);
  });

  lineReader.on("close", () => {
    peer.dispose();
  });

  return {
    peer,
    dispose: () => {
      lineReader.close();
      peer.dispose();
    },
  };
};
