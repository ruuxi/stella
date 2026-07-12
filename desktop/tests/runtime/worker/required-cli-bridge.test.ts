import { describe, expect, it, vi } from "vitest";

import { afterRequiredCliBridgeReady } from "../../../../runtime/worker/required-cli-bridge.js";

describe("required CLI bridge worker readiness gate", () => {
  it("does not construct the worker-ready response until bridge startup resolves", async () => {
    let release!: () => void;
    const startBridge = vi.fn(
      async () => await new Promise<void>((resolve) => (release = resolve)),
    );
    const buildReadyResult = vi.fn(() => ({ ready: true }));
    const pending = afterRequiredCliBridgeReady(startBridge, buildReadyResult);
    await Promise.resolve();
    expect(startBridge).toHaveBeenCalledOnce();
    expect(buildReadyResult).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ ready: true });
    expect(buildReadyResult).toHaveBeenCalledOnce();
  });

  it("propagates bridge startup failure and never reports ready", async () => {
    const buildReadyResult = vi.fn(() => ({ ready: true }));
    await expect(
      afterRequiredCliBridgeReady(async () => {
        throw new Error("secure bridge startup failed");
      }, buildReadyResult),
    ).rejects.toThrow("secure bridge startup failed");
    expect(buildReadyResult).not.toHaveBeenCalled();
  });
});
