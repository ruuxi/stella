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

  // Handle audio chunks from renderer
  const handleAudioChunk = async (_event: Electron.IpcMainEvent, buffer: ArrayBuffer) => {
    if (!capturing || processing) return;

    chunkCount++;

    processing = true;
    try {
      const pcm = new Int16Array(buffer);
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
  };

  // Register IPC handler
  ipcMain.on("wake-word:audio-chunk", handleAudioChunk);

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
