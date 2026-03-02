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
  stop(): void;
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
  let chunkCount = 0;
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

  const scheduleRestart = (reason: string) => {
    if (!capturing || restartTimer) return;
    console.warn(`[WakeWord] Restarting audio capture: ${reason}`);
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

        chunkCount++;

        // Feed the entire buffer to the detector at once.
        // The detector has its own internal 1280-sample chunking and buffer management.
        // Splitting externally corrupts its sliding window state.
        try {
          const result = await detector.predict(incoming);
          if (result.vadScore > 0.3 || result.score > 0.1) {
            console.log(`[WakeWord] vad=${result.vadScore.toFixed(2)} score=${result.score.toFixed(3)} thresh=${detector.getThreshold().toFixed(3)} detected=${result.detected}`);
          }
          if (result.detected && detectionCallback) {
            detectionCallback(result);
          }
        } catch (err) {
          if (chunkCount <= 5) {
            console.error("[WakeWord] Predict error:", (err as Error).message);
          }
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

    // Defensive cleanup: if a stale worker survived a previous stop/restart,
    // terminate it before replacing the reference.
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
          // Ignore events from stale workers that have already been replaced.
          if (worker !== nextWorker) return;

          if (msg.type === "ready") {
            nextWorker.postMessage({ type: "start" });
            return;
          }

          if (msg.type === "started") {
            console.log("[WakeWord] Audio capture worker started");
            return;
          }

          if (msg.type === "start-failed" || msg.type === "stream-error") {
            const reason = msg.error ?? "unknown error";
            console.warn(`[WakeWord] Audio worker ${msg.type}: ${reason}`);
            if (worker === nextWorker) {
              worker = null;
            }
            shutdownWorker(nextWorker);
            scheduleRestart(reason);
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

      if (nextWorker.stdout) {
        nextWorker.stdout.on("data", (data: Buffer) => {
          process.stdout.write(`[AudioWorker] ${data}`);
        });
      }
      if (nextWorker.stderr) {
        nextWorker.stderr.on("data", (data: Buffer) => {
          process.stderr.write(`[AudioWorker] ${data}`);
        });
      }

      nextWorker.on("exit", (code) => {
        if (worker === nextWorker) {
          worker = null;
        }
        if (!capturing) return;
        console.warn(`[WakeWord] Worker exited unexpectedly (code ${code})`);
        scheduleRestart(`worker exited (${code ?? "unknown"})`);
      });
    } catch (err) {
      const message = (err as Error).message;
      console.error("[WakeWord] Failed to start audio worker:", message);
      scheduleRestart(message);
    }
  };

  return {
    start() {
      if (capturing) return;

      capturing = true;
      chunkCount = 0;
      processing = false;
      pendingAudio.length = 0;
      clearRestartTimer();

      // Reset detector state, then start or resume the worker
      void detector.start().then(() => {
        if (!capturing) return;
        if (worker) {
          // Worker already alive — just resume streaming
          worker.postMessage({ type: "start" });
          console.log("[WakeWord] Audio capture resumed");
        } else {
          launchWorker();
        }
      });
    },

    stop() {
      if (!capturing) return;

      capturing = false;
      processing = false;
      detector.stop();
      clearRestartTimer();
      pendingAudio.length = 0;

      // Pause streaming but keep worker alive
      if (worker) {
        try { worker.postMessage({ type: "stop" }); } catch { /* ignore */ }
      }

      console.log("[WakeWord] Audio capture paused");
    },

    onDetection(callback: (result: WakeWordResult) => void) {
      detectionCallback = callback;
    },

    isCapturing() {
      return capturing;
    },
  };
}

