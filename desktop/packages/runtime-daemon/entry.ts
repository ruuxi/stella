import { attachJsonRpcPeerToStreams } from "../runtime-protocol/jsonl.js";
import { createRuntimeDaemonServer } from "./server.js";

const { peer } = attachJsonRpcPeerToStreams({
  input: process.stdin,
  output: process.stdout,
  onError: (error) => {
    console.error("[runtime-daemon] RPC error:", error);
  },
});

createRuntimeDaemonServer(peer);
