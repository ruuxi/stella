import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "../../../electron/process-runtime.js";
import { createHostRunnerResource } from "../../../electron/process-resources/host-runner-resource.js";

describe("host runner resource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the host runner and triggers post-start work after the delay", async () => {
    const runtime = new ProcessRuntime();
    const initializeHostRunner = vi.fn(async () => undefined);
    const onHostRunnerReady = vi.fn();

    createHostRunnerResource({
      processRuntime: runtime,
      isQuitting: () => false,
      initializeHostRunner,
      onHostRunnerReady,
    }).start();

    await Promise.resolve();
    expect(initializeHostRunner).toHaveBeenCalledTimes(1);
    expect(onHostRunnerReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onHostRunnerReady).toHaveBeenCalledTimes(1);
  });

  it("retries failed startup until it succeeds", async () => {
    const runtime = new ProcessRuntime();
    const initializeHostRunner = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const onHostRunnerReady = vi.fn();

    createHostRunnerResource({
      processRuntime: runtime,
      isQuitting: () => false,
      initializeHostRunner,
      onHostRunnerReady,
    }).start();

    await Promise.resolve();
    expect(initializeHostRunner).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(initializeHostRunner).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(onHostRunnerReady).toHaveBeenCalledTimes(1);
  });

  it("does not retry once quit has started", async () => {
    const runtime = new ProcessRuntime();
    let quitting = false;
    const initializeHostRunner = vi.fn(async () => {
      throw new Error("boom");
    });

    createHostRunnerResource({
      processRuntime: runtime,
      isQuitting: () => quitting,
      initializeHostRunner,
      onHostRunnerReady: vi.fn(),
    }).start();

    await Promise.resolve();
    quitting = true;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(initializeHostRunner).toHaveBeenCalledTimes(1);
  });
});
