import { attachJsonRpcPeerToStreams } from "../../stella-runtime-protocol/src/jsonl.js";
import { createRuntimeDaemonServer } from "./server.js";

const { peer } = attachJsonRpcPeerToStreams({
  input: process.stdin,
  output: process.stdout,
  onError: (error) => {
    console.error("[stella-runtime-daemon] RPC error:", error);
  },
});

createRuntimeDaemonServer(peer);
