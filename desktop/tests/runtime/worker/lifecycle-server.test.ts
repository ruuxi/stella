import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WorkerLifecycleServer } from "../../../../runtime/worker/lifecycle-server.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkerLifecycleServer", () => {
  it("replaces a stale lock whose recorded owner is dead", async () => {
    const stellaAppDir = await mkdtemp(path.join(tmpdir(), "stella-lifecycle-"));
    const lifecycle = new WorkerLifecycleServer({
      stellaAppDir,
      onShutdown: () => undefined,
    });

    try {
      await mkdir(lifecycle.paths.rootDir, { recursive: true });
      await writeFile(lifecycle.paths.lockFile, "2147483647", "utf-8");
      await writeFile(lifecycle.paths.pidFile, "2147483647", "utf-8");

      await lifecycle.start();

      expect(await readFile(lifecycle.paths.lockFile, "utf-8")).toBe(
        String(process.pid),
      );
      expect(await readFile(lifecycle.paths.pidFile, "utf-8")).toBe(
        String(process.pid),
      );
    } finally {
      await lifecycle.shutdown("signal");
      await rm(stellaAppDir, { recursive: true, force: true });
    }
  });

  it("delays idle shutdown while active work is in flight", async () => {
    const stellaAppDir = await mkdtemp(path.join(tmpdir(), "stella-lifecycle-"));
    const shutdownReasons: string[] = [];
    let keepAlive = true;
    const lifecycle = new WorkerLifecycleServer({
      stellaAppDir,
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
      await rm(stellaAppDir, { recursive: true, force: true });
    }
  });
});
