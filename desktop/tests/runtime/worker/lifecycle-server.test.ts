import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WorkerLifecycleServer } from "../../../../runtime/worker/lifecycle-server.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkerLifecycleServer", () => {
  it("delays idle shutdown while active work is in flight", async () => {
    const stellaRoot = await mkdtemp(path.join(tmpdir(), "stella-lifecycle-"));
    const shutdownReasons: string[] = [];
    let keepAlive = true;
    const lifecycle = new WorkerLifecycleServer({
      stellaRoot,
      idleShutdownMs: 10,
      shouldKeepAlive: () => keepAlive,
      onShutdown: (reason) => {
        shutdownReasons.push(reason);
      },
    });

    try {
      await lifecycle.start();
      lifecycle.noteClientConnected();
      lifecycle.noteClientDisconnected();

      await delay(35);
      expect(shutdownReasons).toEqual([]);

      keepAlive = false;
      await delay(35);
      expect(shutdownReasons).toEqual(["idle"]);
    } finally {
      await lifecycle.shutdown("signal");
      await rm(stellaRoot, { recursive: true, force: true });
    }
  });
});
