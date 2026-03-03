/**
 * Audio capture manager for wake word detection.
 *
 * Spawns a utility process that captures microphone audio via naudiodon2
 * (PortAudio) and sends 16kHz mono Int16 PCM chunks back via IPC.
 * The utility process keeps naudiodon2 isolated from onnxruntime's DirectML
 * in the main process, avoiding native addon conflicts.
 */

import { utilityProcess, type UtilityProcess } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import type { WakeWordDetector, WakeWordResult } from "./detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AudioCaptureManager {
  /** Start capturing audio and feeding to detector. */
  start(): void;
  /** Stop capturing audio. */
  stop(options?: { releaseDevice?: boolean }): void;
  /** Set callback for wake word detection. */
  onDetection(callback: (result: WakeWordResult) => void): void;
  /** Whether capture is active. */
  isCapturing(): boolean;
}

export function createAudioCaptureManager(
  detector: WakeWordDetector,
): AudioCaptureManager {
  const WORKER_EXIT_TIMEOUT_MS = 2000;
  const RESTART_DELAY_MS = 800;

  let capturing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  let processing = false;
  let worker: UtilityProcess | null = null;
  const pendingAudio: Int16Array[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const shutdownWorker = (target: UtilityProcess) => {
    let exited = false;
    const forceKillTimer = setTimeout(() => {
      if (exited) return;
      try {
        target.kill();
      } catch {
        // Ignore cleanup errors
      }
    }, WORKER_EXIT_TIMEOUT_MS);

    target.once("exit", () => {
      exited = true;
      clearTimeout(forceKillTimer);
    });

    try {
      target.postMessage({ type: "exit" });
    } catch {
      clearTimeout(forceKillTimer);
      try {
        target.kill();
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  const scheduleRestart = () => {
    if (!capturing || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!capturing) return;
      launchWorker();
    }, RESTART_DELAY_MS);
  };

  const processAudioQueue = async () => {
    if (processing || !capturing) return;
    processing = true;

    try {
      while (capturing && pendingAudio.length > 0) {
        const incoming = pendingAudio.shift();
        if (!incoming) continue;

        try {
          const result = await detector.predict(incoming);
          if (result.detected && detectionCallback) {
            detectionCallback(result);
          }
        } catch {
          // Ignore predict errors
        }
      }
    } finally {
      processing = false;
      if (capturing && pendingAudio.length > 0) {
        void processAudioQueue();
      }
    }
  };

  const launchWorker = () => {
    if (!capturing) return;

    if (worker) {
      const staleWorker = worker;
      worker = null;
      shutdownWorker(staleWorker);
    }

    try {
      const workerPath = path.join(__dirname, "audio-worker.js");
      const nextWorker = utilityProcess.fork(workerPath, [], {
        stdio: "pipe",
      });
      worker = nextWorker;

      nextWorker.on(
        "message",
        (msg: { type: string; buffer?: string; error?: string }) => {
          if (worker !== nextWorker) return;

          if (msg.type === "ready") {
            nextWorker.postMessage({ type: "start" });
            return;
          }

          if (msg.type === "started") return;

          if (msg.type === "start-failed" || msg.type === "stream-error") {
            if (worker === nextWorker) {
              worker = null;
            }
            shutdownWorker(nextWorker);
            scheduleRestart();
            return;
          }

          if (msg.type !== "audio" || !msg.buffer || !capturing) return;

          const buf = Buffer.from(msg.buffer, "base64");
          const incoming = new Int16Array(
            buf.buffer,
            buf.byteOffset,
            Math.floor(buf.length / 2),
          );
          pendingAudio.push(incoming);
          void processAudioQueue();
        },
      );

      nextWorker.on("exit", () => {
        if (worker === nextWorker) worker = null;
        if (!capturing) return;
        scheduleRestart();
      });
    } catch {
      scheduleRestart();
    }
  };

  return {
    start() {
      if (capturing) return;

      capturing = true;
      processing = false;
      pendingAudio.length = 0;
      clearRestartTimer();

      void detector.start().then(() => {
        if (!capturing) return;
        if (worker) {
          worker.postMessage({ type: "start" });
        } else {
          launchWorker();
        }
      });
    },

    stop(options?: { releaseDevice?: boolean }) {
      const releaseDevice = options?.releaseDevice === true;
      if (!capturing && !releaseDevice) return;

      capturing = false;
      processing = false;
      detector.stop();
      clearRestartTimer();
      pendingAudio.length = 0;

      if (worker) {
        if (releaseDevice) {
          const activeWorker = worker;
          worker = null;
          shutdownWorker(activeWorker);
        } else {
          try { worker.postMessage({ type: "stop" }); } catch { /* ignore */ }
        }
      }
    },

    onDetection(callback: (result: WakeWordResult) => void) {
      detectionCallback = callback;
    },

    isCapturing() {
      return capturing;
    },
  };
}

