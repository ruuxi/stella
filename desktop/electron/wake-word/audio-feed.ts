import type { WakeWordDetector, WakeWordResult } from "./detector.js";

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
): WakeWordAudioFeedManager {
  let listening = false;
  let desiredListening = false;
  let processing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  const pendingAudio: Int16Array[] = [];
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
          const result = await detector.predict(incoming);
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
      detector.dispose();
    },
  };
}
