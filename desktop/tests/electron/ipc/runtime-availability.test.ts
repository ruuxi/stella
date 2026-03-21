import { describe, expect, it, vi } from "vitest";
import { waitForConnectedRunner } from "../../../electron/ipc/runtime-availability.js";

describe("waitForConnectedRunner", () => {
  it("follows runner replacement notifications instead of getting pinned to the stale instance", async () => {
    const staleListeners = new Set<(snapshot: { connected: boolean; ready: boolean }) => void>();
    const freshListeners = new Set<(snapshot: { connected: boolean; ready: boolean }) => void>();
    const staleRunner = {
      getAvailabilitySnapshot: vi.fn(() => ({
        connected: false,
        ready: false,
        reason: "stale runner failed",
      })),
      onAvailabilityChange: vi.fn((listener: (snapshot: { connected: boolean; ready: boolean }) => void) => {
        staleListeners.add(listener);
        return () => {
          staleListeners.delete(listener);
        };
      }),
    };
    const freshRunner = {
      getAvailabilitySnapshot: vi.fn(() => ({
        connected: false,
        ready: false,
      })),
      onAvailabilityChange: vi.fn((listener: (snapshot: { connected: boolean; ready: boolean }) => void) => {
        freshListeners.add(listener);
        return () => {
          freshListeners.delete(listener);
        };
      }),
    };

    let currentRunner: typeof staleRunner | typeof freshRunner | null = staleRunner;
    const runnerListeners = new Set<(runner: typeof currentRunner) => void>();
    const subscribeToRunnerChange = (listener: (runner: typeof currentRunner) => void) => {
      runnerListeners.add(listener);
      return () => {
        runnerListeners.delete(listener);
      };
    };

    setTimeout(() => {
      currentRunner = freshRunner;
      for (const listener of runnerListeners) {
        listener(currentRunner);
      }
      for (const listener of freshListeners) {
        listener({ connected: true, ready: true });
      }
    }, 40);

    await expect(
      waitForConnectedRunner(() => currentRunner as never, {
        timeoutMs: 300,
        onRunnerChanged: subscribeToRunnerChange as never,
      }),
    ).resolves.toBe(freshRunner);

    expect(staleRunner.onAvailabilityChange).toHaveBeenCalledTimes(1);
    expect(freshRunner.onAvailabilityChange).toHaveBeenCalledTimes(1);
  });
});
