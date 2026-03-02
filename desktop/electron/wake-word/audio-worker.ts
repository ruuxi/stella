/**
 * Audio capture worker — runs as an Electron utilityProcess to avoid native
 * addon conflicts between naudiodon2 (PortAudio) and onnxruntime (DirectML).
 *
 * Captures 16kHz mono Int16 PCM from the default mic and sends chunks
 * to the parent process via IPC.
 */

import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const portAudio = _require("naudiodon2");

// Capture parentPort once — it's either set at startup or never
const port = process.parentPort ?? null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioStream: any = null;

function postMessage(type: string, payload: Record<string, unknown> = {}) {
  if (!port) return;
  port.postMessage({ type, ...payload });
}

function start() {
  if (audioStream) return;

  try {
    audioStream = new portAudio.AudioIO({
      inOptions: {
        channelCount: 1,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: 16000,
        deviceId: -1,
        closeOnError: false,
      },
    });

    audioStream.on("data", (buf: Buffer) => {
      if (!port) return;
      port.postMessage({ type: "audio", buffer: buf.toString("base64") });
    });

    audioStream.on("error", (err: Error) => {
      console.error("[AudioWorker] Stream error:", err.message);
      postMessage("stream-error", { error: err.message });
    });

    audioStream.start();
    postMessage("started");
    console.log("[AudioWorker] Capture started");
  } catch (err) {
    const message = (err as Error).message;
    console.error("[AudioWorker] Failed to start:", message);
    postMessage("start-failed", { error: message });
    audioStream = null;
  }
}

function stop() {
  if (!audioStream) return;
  try {
    audioStream.quit();
  } catch {
    // Ignore cleanup errors
  }
  audioStream = null;
  console.log("[AudioWorker] Capture stopped");
}

// Listen for commands from parent via utilityProcess messaging
if (port) {
  port.on("message", (e: { data: { type: string } }) => {
    const msg = e.data;
    if (msg.type === "start") start();
    else if (msg.type === "stop") stop();
    else if (msg.type === "exit") {
      stop();
      process.exit(0);
    }
  });

  postMessage("ready");
}
