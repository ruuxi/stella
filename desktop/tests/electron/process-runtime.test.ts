import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "../../electron/process-runtime.js";

describe("process runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs cleanups in reverse registration order", async () => {
    const runtime = new ProcessRuntime();
    const calls: string[] = [];

    runtime.registerCleanup("before-quit", "first", () => {
      calls.push("first");
    });
    runtime.registerCleanup("before-quit", "second", () => {
      calls.push("second");
    });

    await runtime.runPhase("before-quit");

    expect(calls).toEqual(["second", "first"]);
  });

  it("clears managed timers when shutdown starts", async () => {
    const runtime = new ProcessRuntime();
    const onTimeout = vi.fn();
    const onInterval = vi.fn();

    runtime.setManagedTimeout(onTimeout, 50);
    runtime.setManagedInterval(onInterval, 25);

    await runtime.runPhase("before-quit");
    await vi.advanceTimersByTimeAsync(100);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(onInterval).not.toHaveBeenCalled();
  });

  it("resolves managed waits as cancelled during shutdown", async () => {
    const runtime = new ProcessRuntime();
    const waitPromise = runtime.wait(50);

    await runtime.runPhase("before-quit");

    await expect(waitPromise).resolves.toBe(false);
  });
});
