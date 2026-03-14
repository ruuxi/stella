import { describe, expect, it, vi } from "vitest";
import {
  calculateWakeWordInputLevel,
  createWakeWordAdaptiveNoiseFloor,
  createWakeWordAudioFeedManager,
} from "../../../electron/wake-word/audio-feed.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPcmChunk(level: number, length = 1280): Int16Array {
  const amplitude = Math.round(Math.max(0, Math.min(1, level)) * 32767);
  return Int16Array.from(
    { length },
    (_, index) => (index % 2 === 0 ? amplitude : -amplitude),
  );
}

function observeFrontEndResult(
  frontEnd: ReturnType<typeof createWakeWordAdaptiveNoiseFloor>,
  result: { detected?: boolean; score?: number; vadScore: number },
) {
  frontEnd.observeResult({
    detected: result.detected ?? false,
    score: result.score ?? 0,
    vadScore: result.vadScore,
  });
}

describe("WakeWordAudioFeedManager", () => {
  it("measures PCM input level as normalized RMS", () => {
    expect(calculateWakeWordInputLevel(createPcmChunk(0.25, 8))).toBeCloseTo(0.25, 2);
  });

  it("suppresses steady ambient noise until a chunk rises above the learned floor", () => {
    const frontEnd = createWakeWordAdaptiveNoiseFloor({
      floorSlowRiseRate: 0.25,
      signalHoldFrames: 0,
    });

    let ambient = frontEnd.process(createPcmChunk(0.01));
    for (let i = 0; i < 5; i += 1) {
      ambient = frontEnd.process(createPcmChunk(0.01));
    }

    expect(ambient.frontEnd.gateOpen).toBe(false);
    expect(ambient.frontEnd.noiseFloor).toBeGreaterThan(0.0075);
    expect(ambient.pcm.every((sample) => sample === 0)).toBe(true);

    const speech = frontEnd.process(createPcmChunk(0.02));

    expect(speech.frontEnd.signalPresent).toBe(true);
    expect(speech.frontEnd.gateOpen).toBe(true);
    expect(speech.frontEnd.signalDelta).toBeGreaterThan(0.004);
    expect(speech.pcm).toEqual(createPcmChunk(0.02));
  });

  it("adapts upward in louder environments without reopening for the new ambient floor", () => {
    const frontEnd = createWakeWordAdaptiveNoiseFloor({
      floorSlowRiseRate: 0.35,
      signalHoldFrames: 0,
    });

    let reading = frontEnd.process(createPcmChunk(0.006));
    const initialFloor = reading.frontEnd.nextNoiseFloor;

    for (let i = 0; i < 8; i += 1) {
      reading = frontEnd.process(createPcmChunk(0.018));
      observeFrontEndResult(frontEnd, { vadScore: 0.1 });
    }

    const adaptedReading = frontEnd.getState();

    expect(adaptedReading.nextNoiseFloor).toBeGreaterThan(initialFloor);
    expect(adaptedReading.nextNoiseFloor).toBeGreaterThan(0.015);

    const louderAmbient = frontEnd.process(createPcmChunk(0.02));
    expect(louderAmbient.frontEnd.gateOpen).toBe(false);

    const speech = frontEnd.process(createPcmChunk(0.03));
    expect(speech.frontEnd.gateOpen).toBe(true);
    expect(speech.frontEnd.signalPresent).toBe(true);
  });

  it("holds the front-end gate open briefly across short signal dropouts", () => {
    const frontEnd = createWakeWordAdaptiveNoiseFloor({
      signalHoldFrames: 2,
    });

    frontEnd.process(createPcmChunk(0.008));

    const speech = frontEnd.process(createPcmChunk(0.025));
    const tailOne = frontEnd.process(createPcmChunk(0.007));
    const tailTwo = frontEnd.process(createPcmChunk(0.007));
    const tailThree = frontEnd.process(createPcmChunk(0.007));

    expect(speech.frontEnd.gateOpen).toBe(true);
    expect(tailOne.frontEnd.signalPresent).toBe(false);
    expect(tailOne.frontEnd.gateOpen).toBe(true);
    expect(tailTwo.frontEnd.gateOpen).toBe(true);
    expect(tailThree.frontEnd.gateOpen).toBe(false);
  });

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
    expect(onDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        score: 0.91,
        vadScore: 0.7,
      }),
    );
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

  it("feeds chunk-sized silence into the detector when ambient audio stays below the adaptive gate", async () => {
    const detector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      predict: vi
        .fn()
        .mockResolvedValue({ detected: false, score: 0.2, vadScore: 0.1 }),
      calibrate: vi.fn(),
      setThreshold: vi.fn(),
      getThreshold: vi.fn(() => 0.6),
      isListening: vi.fn(() => true),
      dispose: vi.fn(),
    };

    const manager = createWakeWordAudioFeedManager(detector);

    await manager.start();
    manager.pushAudio(createPcmChunk(0.01));
    manager.pushAudio(createPcmChunk(0.03));

    await vi.waitFor(() => {
      expect(detector.predict).toHaveBeenCalledTimes(2);
    });

    expect(detector.predict.mock.calls[0]?.[0]).toEqual(new Int16Array(1280));
    expect(detector.predict.mock.calls[1]?.[0]).toEqual(createPcmChunk(0.03));
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
