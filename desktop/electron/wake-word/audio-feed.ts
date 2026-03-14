import type {
  WakeWordDetector,
  WakeWordFrontEndState,
  WakeWordResult,
} from "./detector.js";

const PCM_NORMALIZATION_FACTOR = 32768;

export interface WakeWordAdaptiveNoiseFloorOptions {
  bootstrapFloorRatio: number;
  floorFastFallRate: number;
  floorSlowRiseRate: number;
  signalFloorRatio: number;
  signalFloorMargin: number;
  minimumSignalLevel: number;
  signalHoldFrames: number;
  speechVadThreshold: number;
}

export interface WakeWordPreparedAudio {
  pcm: Int16Array;
  frontEnd: WakeWordFrontEndState;
}

export interface WakeWordAdaptiveNoiseFloorStage {
  process(pcm: Int16Array): WakeWordPreparedAudio;
  observeResult(result: WakeWordResult): void;
  reset(): void;
  getState(): WakeWordFrontEndState;
}

export interface WakeWordAudioFeedManagerOptions {
  frontEnd?: WakeWordAdaptiveNoiseFloorStage;
}

const DEFAULT_ADAPTIVE_NOISE_FLOOR_OPTIONS: WakeWordAdaptiveNoiseFloorOptions = {
  bootstrapFloorRatio: 0.8,
  floorFastFallRate: 0.2,
  floorSlowRiseRate: 0.02,
  signalFloorRatio: 1.8,
  signalFloorMargin: 0.004,
  minimumSignalLevel: 0.0025,
  signalHoldFrames: 3,
  speechVadThreshold: 0.5,
};

function createIdleFrontEndState(
  options: WakeWordAdaptiveNoiseFloorOptions,
): WakeWordFrontEndState {
  return {
    inputLevel: 0,
    noiseFloor: 0,
    nextNoiseFloor: 0,
    signalThreshold: options.minimumSignalLevel,
    signalDelta: 0,
    signalPresent: false,
    gateOpen: false,
  };
}

export function calculateWakeWordInputLevel(pcm: Int16Array): number {
  if (pcm.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] / PCM_NORMALIZATION_FACTOR;
    sum += sample * sample;
  }

  return Math.sqrt(sum / pcm.length);
}

export function createWakeWordAdaptiveNoiseFloor(
  options: Partial<WakeWordAdaptiveNoiseFloorOptions> = {},
): WakeWordAdaptiveNoiseFloorStage {
  const resolvedOptions = {
    ...DEFAULT_ADAPTIVE_NOISE_FLOOR_OPTIONS,
    ...options,
  };

  let trackedNoiseFloor = 0;
  let holdFramesRemaining = 0;
  let lastState = createIdleFrontEndState(resolvedOptions);

  return {
    process(pcm: Int16Array): WakeWordPreparedAudio {
      const inputLevel = calculateWakeWordInputLevel(pcm);
      const noiseFloor =
        trackedNoiseFloor > 0
          ? trackedNoiseFloor
          : inputLevel * resolvedOptions.bootstrapFloorRatio;
      const signalThreshold = Math.max(
        noiseFloor * resolvedOptions.signalFloorRatio,
        noiseFloor + resolvedOptions.signalFloorMargin,
        resolvedOptions.minimumSignalLevel,
      );
      const signalDelta = Math.max(0, inputLevel - noiseFloor);
      const signalPresent =
        inputLevel >= resolvedOptions.minimumSignalLevel &&
        (inputLevel >= signalThreshold ||
          signalDelta > resolvedOptions.signalFloorMargin);

      let gateOpen = signalPresent;
      if (signalPresent) {
        holdFramesRemaining = resolvedOptions.signalHoldFrames;
      } else if (holdFramesRemaining > 0) {
        holdFramesRemaining -= 1;
        gateOpen = true;
      }

      let nextNoiseFloor = noiseFloor;
      if (noiseFloor <= 0) {
        nextNoiseFloor = 0;
      } else if (!gateOpen) {
        const rate =
          inputLevel <= noiseFloor
            ? resolvedOptions.floorFastFallRate
            : resolvedOptions.floorSlowRiseRate;
        nextNoiseFloor = noiseFloor + (inputLevel - noiseFloor) * rate;
      }

      trackedNoiseFloor = nextNoiseFloor;
      lastState = {
        inputLevel,
        noiseFloor,
        nextNoiseFloor,
        signalThreshold,
        signalDelta,
        signalPresent,
        gateOpen,
      };

      return {
        pcm: gateOpen || pcm.length === 0 ? pcm : new Int16Array(pcm.length),
        frontEnd: lastState,
      };
    },

    observeResult(result: WakeWordResult) {
      if (
        !lastState.signalPresent ||
        result.detected ||
        result.vadScore >= resolvedOptions.speechVadThreshold ||
        lastState.inputLevel <= lastState.noiseFloor
      ) {
        return;
      }

      trackedNoiseFloor =
        lastState.noiseFloor +
        (lastState.inputLevel - lastState.noiseFloor) *
          resolvedOptions.floorSlowRiseRate;
      lastState = {
        ...lastState,
        nextNoiseFloor: trackedNoiseFloor,
      };
    },

    reset() {
      trackedNoiseFloor = 0;
      holdFramesRemaining = 0;
      lastState = createIdleFrontEndState(resolvedOptions);
    },

    getState() {
      return lastState;
    },
  };
}

export interface WakeWordAudioFeedManager {
  start(): Promise<void>;
  stop(): void;
  pushAudio(pcm: Int16Array): void;
  onDetection(callback: (result: WakeWordResult) => void): void;
  isListening(): boolean;
  dispose(): void;
}

export function createWakeWordAudioFeedManager(
  detector: WakeWordDetector,
  options: WakeWordAudioFeedManagerOptions = {},
): WakeWordAudioFeedManager {
  let listening = false;
  let desiredListening = false;
  let processing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  const pendingAudio: Int16Array[] = [];
  const frontEnd = options.frontEnd ?? createWakeWordAdaptiveNoiseFloor();
  let startPromise: Promise<void> | null = null;
  let startRequestId = 0;
  let listeningSessionId = 0;

  const processAudioQueue = async (sessionId = listeningSessionId) => {
    if (processing || !listening || sessionId !== listeningSessionId) {
      return;
    }
    processing = true;

    try {
      while (
        listening &&
        sessionId === listeningSessionId &&
        pendingAudio.length > 0
      ) {
        const incoming = pendingAudio.shift();
        if (!incoming) {
          continue;
        }

        try {
          const prepared = frontEnd.process(incoming);
          const detectorResult = await detector.predict(prepared.pcm);
          frontEnd.observeResult(detectorResult);
          const result = {
            ...detectorResult,
            frontEnd: frontEnd.getState(),
          } satisfies WakeWordResult;
          if (!listening || sessionId !== listeningSessionId) {
            continue;
          }
          if (result.detected) {
            detectionCallback?.(result);
          }
        } catch (error) {
          console.error(
            "[WakeWord] Detector prediction failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      processing = false;
      if (listening && pendingAudio.length > 0) {
        void processAudioQueue();
      }
    }
  };

  const startListening = async (): Promise<void> => {
    desiredListening = true;
    pendingAudio.length = 0;

    if (listening) {
      return;
    }

    if (startPromise) {
      await startPromise;
      if (desiredListening && !listening) {
        await startListening();
      }
      return;
    }

    const requestId = ++startRequestId;
    frontEnd.reset();
    const pendingStart = detector
      .start()
      .then(() => {
        if (requestId !== startRequestId || !desiredListening) {
          detector.stop();
          return;
        }

        listening = true;
        listeningSessionId += 1;
      })
      .finally(() => {
        if (startPromise === pendingStart) {
          startPromise = null;
        }
      });

    startPromise = pendingStart;
    await pendingStart;
  };

  return {
    start: startListening,

    stop() {
      const shouldStopDetector = listening || startPromise !== null;

      desiredListening = false;
      startRequestId += 1;
      listeningSessionId += 1;
      listening = false;
      pendingAudio.length = 0;
      frontEnd.reset();

      if (shouldStopDetector) {
        detector.stop();
      }
    },

    pushAudio(pcm: Int16Array) {
      if (!listening || pcm.length === 0) {
        return;
      }
      pendingAudio.push(pcm);
      void processAudioQueue();
    },

    onDetection(callback: (result: WakeWordResult) => void) {
      detectionCallback = callback;
    },

    isListening() {
      return listening;
    },

    dispose() {
      desiredListening = false;
      startRequestId += 1;
      listeningSessionId += 1;
      listening = false;
      pendingAudio.length = 0;
      frontEnd.reset();
      detector.dispose();
    },
  };
}
