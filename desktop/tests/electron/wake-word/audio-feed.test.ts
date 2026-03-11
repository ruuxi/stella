import { describe, expect, it, vi } from "vitest";
import { createWakeWordAudioFeedManager } from "../../../electron/wake-word/audio-feed.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WakeWordAudioFeedManager", () => {
  it("runs queued audio through the detector and emits detections", async () => {
    const detector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      predict: vi
        .fn()
        .mockResolvedValueOnce({ detected: false, score: 0.2, vadScore: 0.4 })
        .mockResolvedValueOnce({ detected: true, score: 0.91, vadScore: 0.7 }),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => true),
      dispose: vi.fn(),
    };

    const manager = createWakeWordAudioFeedManager(detector);
    const onDetection = vi.fn();
    manager.onDetection(onDetection);

    await manager.start();
    manager.pushAudio(new Int16Array([1, 2, 3]));
    manager.pushAudio(new Int16Array([4, 5, 6]));

    await vi.waitFor(() => {
      expect(detector.predict).toHaveBeenCalledTimes(2);
    });

    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection).toHaveBeenCalledWith({
      detected: true,
      score: 0.91,
      vadScore: 0.7,
    });
  });

  it("ignores pushed audio while not listening", async () => {
    const detector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      predict: vi
        .fn()
        .mockResolvedValue({ detected: true, score: 1, vadScore: 1 }),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => false),
      dispose: vi.fn(),
    };

    const manager = createWakeWordAudioFeedManager(detector);
    manager.pushAudio(new Int16Array([1, 2, 3]));

    await Promise.resolve();

    expect(detector.predict).not.toHaveBeenCalled();

    await manager.start();
    manager.stop();
    manager.pushAudio(new Int16Array([4, 5, 6]));

    await Promise.resolve();

    expect(detector.predict).not.toHaveBeenCalled();
    expect(detector.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending startup when stop is called before start resolves", async () => {
    const startDeferred = createDeferred<void>();
    const detector = {
      start: vi.fn(() => startDeferred.promise),
      stop: vi.fn(),
      predict: vi
        .fn()
        .mockResolvedValue({ detected: true, score: 1, vadScore: 1 }),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => false),
      dispose: vi.fn(),
    };

    const manager = createWakeWordAudioFeedManager(detector);
    const startPromise = manager.start();

    manager.stop();
    startDeferred.resolve();
    await startPromise;

    manager.pushAudio(new Int16Array([1, 2, 3]));
    await Promise.resolve();

    expect(manager.isListening()).toBe(false);
    expect(detector.stop).toHaveBeenCalled();
    expect(detector.predict).not.toHaveBeenCalled();
  });

  it("does not emit detections from a prediction that resolves after stop", async () => {
    const predictDeferred = createDeferred<{
      detected: boolean;
      score: number;
      vadScore: number;
    }>();
    const detector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      predict: vi.fn(() => predictDeferred.promise),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => true),
      dispose: vi.fn(),
    };

    const manager = createWakeWordAudioFeedManager(detector);
    const onDetection = vi.fn();
    manager.onDetection(onDetection);

    await manager.start();
    manager.pushAudio(new Int16Array([1, 2, 3]));

    await vi.waitFor(() => {
      expect(detector.predict).toHaveBeenCalledTimes(1);
    });

    manager.stop();
    predictDeferred.resolve({ detected: true, score: 0.97, vadScore: 0.8 });

    await Promise.resolve();
    await Promise.resolve();

    expect(onDetection).not.toHaveBeenCalled();
  });
});
