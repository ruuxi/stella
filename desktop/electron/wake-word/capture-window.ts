/**
 * Hidden BrowserWindow dedicated to wake word audio capture.
 *
 * Always loaded, always listening. Captures mic audio via Web Audio API
 * and streams 16kHz mono Int16 PCM chunks to the main process via IPC.
 * Completely independent of the voice UI window.
 */

import { BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { getDevServerUrl } from "../dev-url.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === "development";

let captureWindow: BrowserWindow | null = null;

const getDevUrl = () => {
  const url = new URL(getDevServerUrl());
  url.searchParams.set("window", "wake-word-capture");
  return url.toString();
};

const getProdTarget = () => ({
  filePath: path.join(__dirname, "../../dist/index.html"),
  query: { window: "wake-word-capture" },
});

export const createCaptureWindow = (): BrowserWindow => {
  if (captureWindow) return captureWindow;

  captureWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:Stella",
    },
  });

  if (isDev) {
    captureWindow.loadURL(getDevUrl());
  } else {
    const target = getProdTarget();
    captureWindow.loadFile(target.filePath, { query: target.query });
  }

  captureWindow.on("closed", () => {
    captureWindow = null;
  });

  return captureWindow;
};

export const getCaptureWindow = (): BrowserWindow | null => captureWindow;
