import { attachJsonRpcPeerToStreams } from "../../stella-runtime-protocol/src/jsonl.js";
import { createRuntimeWorkerServer } from "./server.js";

const { peer } = attachJsonRpcPeerToStreams({
  input: process.stdin,
  output: process.stdout,
  onError: (error) => {
    console.error("[stella-runtime-worker] RPC error:", error);
  },
});

createRuntimeWorkerServer(peer);
