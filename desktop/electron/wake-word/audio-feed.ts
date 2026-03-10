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
  let processing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  const pendingAudio: Int16Array[] = [];

  const processAudioQueue = async () => {
    if (processing || !listening) {
      return;
    }
    processing = true;

    try {
      while (listening && pendingAudio.length > 0) {
        const incoming = pendingAudio.shift();
        if (!incoming) {
          continue;
        }

        try {
          const result = await detector.predict(incoming);
          if (result.detected) {
            detectionCallback?.(result);
          }
        } catch {
          // Ignore detector errors and continue listening.
        }
      }
    } finally {
      processing = false;
      if (listening && pendingAudio.length > 0) {
        void processAudioQueue();
      }
    }
  };

  return {
    async start() {
      if (listening) {
        return;
      }
      pendingAudio.length = 0;
      await detector.start();
      listening = true;
    },

    stop() {
      if (!listening) {
        pendingAudio.length = 0;
        return;
      }
      listening = false;
      pendingAudio.length = 0;
      detector.stop();
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
      listening = false;
      pendingAudio.length = 0;
      detector.dispose();
    },
  };
}
