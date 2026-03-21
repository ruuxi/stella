import { describe, expect, it, vi } from "vitest";
import { waitForConnectedRunner } from "../../../electron/ipc/runtime-availability.js";

describe("waitForConnectedRunner", () => {
  it("retries against a replacement runner instead of waiting on the stale instance for the full timeout", async () => {
    const staleRunner = {
      waitUntilConnected: vi.fn(
        async (timeoutMs: number) =>
          await new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`stale runner failed after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
      ),
    };
    const freshRunner = {
      waitUntilConnected: vi.fn(async () => {}),
    };

    let currentRunner: typeof staleRunner | typeof freshRunner | null = staleRunner;
    setTimeout(() => {
      currentRunner = freshRunner;
    }, 40);

    await expect(
      waitForConnectedRunner(() => currentRunner as never, {
        timeoutMs: 300,
        connectAttemptMs: 25,
        pollMs: 10,
      }),
    ).resolves.toBe(freshRunner);

    expect(staleRunner.waitUntilConnected).toHaveBeenCalled();
    expect(freshRunner.waitUntilConnected).toHaveBeenCalledTimes(1);
  });
});
