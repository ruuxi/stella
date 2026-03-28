import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeWorkerLifecycleController,
  type WorkerConnection,
} from "../../../packages/runtime-client/worker-lifecycle.js";

class FakeChildProcess extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signalCode = signal;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, signal);
    });
    return true;
  }
}

const createFakeConnection = () => {
  const process = new FakeChildProcess();
  const peer = {
    request: vi.fn(async () => ({ ok: true })),
  };
  return {
    connection: {
      process: process as unknown as WorkerConnection["process"],
      peer: peer as unknown as WorkerConnection["peer"],
      pid: process.pid,
    } satisfies WorkerConnection,
    process,
    peer,
  };
};

describe("runtime worker lifecycle controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops an unpinned worker after the idle timeout", async () => {
    const { connection } = createFakeConnection();
    const onAfterStop = vi.fn(async () => undefined);

    const controller = new RuntimeWorkerLifecycleController({
      workerEntryPath: "worker.js",
      createConnection: () => connection,
      isHostStarted: () => true,
      initializeConnection: async () => undefined,
      onConnectionStarted: async () => undefined,
      onUnexpectedExit: async () => undefined,
      onAfterStop,
      fetchHealth: async () => ({
        health: { ready: true },
        activeRun: null,
        activeTaskCount: 0,
        pid: connection.pid,
        deviceId: null,
      }),
      shouldKeepAlive: () => false,
      idleTimeoutMs: 25,
      idleRecheckMs: 10,
    });

    await controller.ensureStarted();
    await vi.advanceTimersByTimeAsync(30);

    expect(onAfterStop).toHaveBeenCalledWith("idle");
    expect(controller.getState()).toBe("idle");
  });

  it("retries a request once after disconnect when configured", async () => {
    const first = createFakeConnection();
    const second = createFakeConnection();
    const connections = [first.connection, second.connection];
    let healthRequestCount = 0;

    const controller = new RuntimeWorkerLifecycleController({
      workerEntryPath: "worker.js",
      createConnection: () => {
        const next = connections.shift();
        if (!next) {
          throw new Error("No more fake connections");
        }
        return next;
      },
      isHostStarted: () => true,
      initializeConnection: async () => undefined,
      onConnectionStarted: async () => undefined,
      onUnexpectedExit: async () => undefined,
      onAfterStop: async () => undefined,
      fetchHealth: async () => {
        healthRequestCount += 1;
        return {
          health: { ready: true },
          activeRun: null,
          activeTaskCount: 0,
          pid: 1234,
          deviceId: null,
        };
      },
      shouldKeepAlive: () => true,
      idleTimeoutMs: 1_000,
      idleRecheckMs: 50,
    });

    await controller.ensureStarted();

    let attempts = 0;
    const result = await controller.request(async () => {
      attempts += 1;
      if (attempts === 1) {
        first.process.emit("exit", 1, null);
        throw new Error("peer disconnected");
      }
      return "ok";
    }, {
      ensureWorker: true,
      recordActivity: true,
      retryOnceOnDisconnect: true,
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(healthRequestCount).toBe(0);
  });
});
