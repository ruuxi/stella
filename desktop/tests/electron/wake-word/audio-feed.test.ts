import { describe, expect, it, vi } from "vitest";
import { createWakeWordAudioFeedManager } from "../../../electron/wake-word/audio-feed.js";

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
});
