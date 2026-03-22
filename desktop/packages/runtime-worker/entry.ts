import { attachJsonRpcPeerToStreams } from "../runtime-protocol/jsonl.js";
import { createRuntimeWorkerServer } from "./server.js";

const { peer } = attachJsonRpcPeerToStreams({
  input: process.stdin,
  output: process.stdout,
  onError: (error) => {
    console.error("[runtime-worker] RPC error:", error);
  },
});

createRuntimeWorkerServer(peer);
