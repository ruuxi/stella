/**
 * Audio capture manager for wake word detection.
 *
 * Captures microphone audio from the hidden capture window via IPC
 * and feeds it to the wake word detector in the main process.
 *
 * Flow:
 *   Renderer (capture window) → ScriptProcessorNode captures audio
 *   → Resamples to 16kHz mono → Converts to Int16 PCM
 *   → IPC send 'wake-word:audio-chunk' to main process
 *   → Main process feeds to WakeWordDetector.predict()
 */

import { ipcMain, BrowserWindow } from "electron";
import type { WakeWordDetector, WakeWordResult } from "./detector.js";

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
  getVoiceWindow: () => BrowserWindow | null
): AudioCaptureManager {
  let capturing = false;
  let detectionCallback: ((result: WakeWordResult) => void) | null = null;
  let processing = false; // prevent overlapping predict calls

  let chunkCount = 0;
  let droppedCount = 0;

  // Handle audio chunks from renderer
  const handleAudioChunk = async (_event: Electron.IpcMainEvent, buffer: ArrayBuffer) => {
    if (!capturing) return;
    if (processing) {
      droppedCount++;
      return;
    }

    chunkCount++;

    processing = true;
    const predictStart = performance.now();
    try {
      const pcm = new Int16Array(buffer);
      const result = await detector.predict(pcm);

      // Log periodically for diagnostics
      if (chunkCount % 50 === 1) {
        const elapsed = performance.now() - predictStart;
        console.log(`[WakeWord] chunk=${chunkCount} dropped=${droppedCount} score=${result.score.toFixed(3)} vad=${result.vadScore.toFixed(3)} predict=${elapsed.toFixed(0)}ms`);
      }

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
  };

  // Register IPC handler
  ipcMain.on("wake-word:audio-chunk", handleAudioChunk);

  // When the renderer signals it's mounted, re-send start if we're supposed to be capturing.
  // This fixes the race where start-capture was sent before the component mounted.
  ipcMain.on("wake-word:renderer-ready", () => {
    if (capturing) {
      const win = getVoiceWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("wake-word:start-capture");
        console.log("[WakeWord] Renderer ready — re-sent start-capture");
      }
    }
  });

  return {
    start() {
      if (capturing) return;
      capturing = true;
      detector.start();

      // Tell the voice window renderer to start capturing
      const win = getVoiceWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("wake-word:start-capture");
      }
    },

    stop() {
      if (!capturing) return;
      capturing = false;
      detector.stop();

      // Tell renderer to stop
      const win = getVoiceWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("wake-word:stop-capture");
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
