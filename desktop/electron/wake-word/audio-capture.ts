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
  let capturing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  let processing = false;
  let worker: UtilityProcess | null = null;
  let chunkCount = 0;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    start() {
      if (capturing) return;
      // Cancel any pending kill timer from a previous stop()
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      capturing = true;
      chunkCount = 0;
      detector.start();

      try {
        const workerPath = path.join(__dirname, "audio-worker.js");
        worker = utilityProcess.fork(workerPath, [], {
          stdio: "pipe",
        });

        worker.on("message", async (msg: { type: string; buffer?: ArrayBuffer }) => {
          if (msg.type === "ready") {
            if (worker) worker.postMessage({ type: "start" });
            console.log("[WakeWord] Audio capture worker started");
            return;
          }

          if (msg.type !== "audio" || !msg.buffer || !capturing || processing) return;

          chunkCount++;
          processing = true;
          try {
            const pcm = new Int16Array(msg.buffer);
            const result = await detector.predict(pcm);
            if (result.detected && detectionCallback) {
              detectionCallback(result);
            }
          } catch (err) {
            if (chunkCount <= 5) {
              console.error("[WakeWord] Predict error:", (err as Error).message);
            }
          } finally {
            processing = false;
          }
        });

        if (worker.stdout) {
          worker.stdout.on("data", (data: Buffer) => {
            process.stdout.write(`[AudioWorker] ${data}`);
          });
        }
        if (worker.stderr) {
          worker.stderr.on("data", (data: Buffer) => {
            process.stderr.write(`[AudioWorker] ${data}`);
          });
        }

        worker.on("exit", (code) => {
          if (capturing) {
            console.warn(`[WakeWord] Worker exited unexpectedly (code ${code})`);
          }
          worker = null;
        });
      } catch (err) {
        console.error("[WakeWord] Failed to start audio worker:", (err as Error).message);
        capturing = false;
      }
    },

    stop() {
      if (!capturing) return;
      capturing = false;
      detector.stop();

      if (worker) {
        try {
          // Send "exit" for clean shutdown (stops audio + exits process)
          worker.postMessage({ type: "exit" });
          // Force-kill if it doesn't exit within 2s
          killTimer = setTimeout(() => {
            killTimer = null;
            if (worker) {
              worker.kill();
              worker = null;
            }
          }, 2000);
        } catch {
          worker.kill();
          worker = null;
        }
      }
      console.log("[WakeWord] Audio capture stopped");
    },

    onDetection(callback: (result: WakeWordResult) => void) {
      detectionCallback = callback;
    },

    isCapturing() {
      return capturing;
    },
  };
}
