import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeWorkerLifecycleController,
  type WorkerConnection,
} from "../../../../runtime/host/worker-lifecycle.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createMockConnection = (): WorkerConnection => {
  const process = new EventEmitter() as WorkerConnection["process"];
  process.pid = 12345;
  process.kill = vi.fn(() => {
    queueMicrotask(() => process.emit("exit", 0, null));
    return true;
  }) as WorkerConnection["process"]["kill"];
  process.stdin = new EventEmitter() as WorkerConnection["process"]["stdin"];
  process.stdout = new EventEmitter() as WorkerConnection["process"]["stdout"];
  process.stderr = new EventEmitter() as WorkerConnection["process"]["stderr"];

  return {
    process,
    pid: 12345,
    peer: {
      isClosed: () => false,
      on: () => () => {},
    } as WorkerConnection["peer"],
  };
};

describe("RuntimeWorkerLifecycleController", () => {
  it("waits for idleTimeoutMs after unfocus before stopping an idle worker", async () => {
    const onAfterStop = vi.fn();
    const connection = createMockConnection();
    const controller = new RuntimeWorkerLifecycleController({
      workerEntryPath: "/tmp/stella/runtime-worker.js",
      isHostStarted: () => true,
      createConnection: () => connection,
      initializeConnection: async () => {},
      onConnectionStarted: async () => {},
      onUnexpectedExit: async () => {},
      onAfterStop,
      fetchHealth: async () => ({
        health: { ready: true },
        activeRun: null,
        activeAgentCount: 0,
        pid: connection.pid,
        deviceId: "device-a",
      }),
      idleTimeoutMs: 25,
    });

    await controller.ensureStarted();
    controller.setHostFocused(false);

    await delay(10);
    expect(onAfterStop).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("running");

    await delay(40);
    expect(onAfterStop).toHaveBeenCalledWith("idle");
    expect(controller.getState()).toBe("idle");
  });

  it("does not wait for the 5s exit fallback after an explicit detached-worker kill", async () => {
    const onAfterStop = vi.fn();
    const killWorker = vi.fn(async () => undefined);
    const connection = createMockConnection();
    connection.process.kill = vi.fn(() => true) as WorkerConnection["process"]["kill"];
    connection.process.stdin.end = vi.fn(() => {
      queueMicrotask(() => connection.process.emit("exit", 0, null));
      return connection.process.stdin;
    }) as WorkerConnection["process"]["stdin"]["end"];

    const controller = new RuntimeWorkerLifecycleController({
      workerEntryPath: "/tmp/stella/runtime-worker.js",
      isHostStarted: () => true,
      createConnection: () => connection,
      initializeConnection: async () => {},
      onConnectionStarted: async () => {},
      onUnexpectedExit: async () => {},
      onAfterStop,
      fetchHealth: async () => ({
        health: { ready: true },
        activeRun: null,
        activeAgentCount: 0,
        pid: connection.pid,
        deviceId: "device-a",
      }),
      killWorkerOnStop: (reason) => reason === "restart",
      killWorker,
    });

    await controller.ensureStarted();
    const startedAt = Date.now();
    await controller.stop("restart");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(killWorker).toHaveBeenCalledOnce();
    expect(connection.process.stdin.end).toHaveBeenCalled();
    expect(onAfterStop).toHaveBeenCalledWith("restart");
    expect(controller.getState()).toBe("idle");
  });
});
