/**
 * Audio capture worker — runs as an Electron utilityProcess to avoid native
 * addon conflicts between naudiodon2 (PortAudio) and onnxruntime (DirectML).
 *
 * Captures audio from the default mic at the device's native rate, resamples
 * to 16kHz mono Int16 PCM, and sends 1280-sample chunks to the parent.
 * The audio stream stays alive across pause/resume cycles to avoid PortAudio
 * reinitialization issues.
 */

import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const portAudio = _require("naudiodon2");

const port = process.parentPort ?? null;

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1280;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioStream: any = null;
let streaming = false; // whether to forward audio to parent
let remainder = new Int16Array(0); // buffer for leftover samples across chunks

function postMessage(type: string, payload: Record<string, unknown> = {}) {
  if (!port) return;
  port.postMessage({ type, ...payload });
}

function initStream() {
  if (audioStream) return;

  try {
    const devices = portAudio.getDevices();
    const defaultInput = devices.find(
      (d: { defaultSampleRate: number; maxInputChannels: number }) => d.maxInputChannels > 0,
    );
    const captureRate = defaultInput?.defaultSampleRate ?? 48000;

    audioStream = new portAudio.AudioIO({
      inOptions: {
        channelCount: 1,
        sampleFormat: portAudio.SampleFormat16Bit,
        sampleRate: captureRate,
        deviceId: -1,
        closeOnError: false,
      },
    });

    const ratio = TARGET_RATE / captureRate;

    audioStream.on("data", (buf: Buffer) => {
      if (!port || !streaming) return;

      const input = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

      // Resample to 16kHz
      let resampled: Int16Array;
      if (captureRate === TARGET_RATE) {
        resampled = input;
      } else {
        const outLen = Math.round(input.length * ratio);
        resampled = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const srcIdx = i / ratio;
          const lo = Math.floor(srcIdx);
          const hi = Math.min(lo + 1, input.length - 1);
          const frac = srcIdx - lo;
          resampled[i] = Math.round(input[lo] * (1 - frac) + input[hi] * frac);
        }
      }

      // Combine with leftover
      let samples: Int16Array;
      if (remainder.length > 0) {
        samples = new Int16Array(remainder.length + resampled.length);
        samples.set(remainder);
        samples.set(resampled, remainder.length);
        remainder = new Int16Array(0);
      } else {
        samples = resampled;
      }

      // Send exactly 1280-sample chunks
      let offset = 0;
      while (offset + CHUNK_SAMPLES <= samples.length) {
        const chunk = samples.slice(offset, offset + CHUNK_SAMPLES);
        offset += CHUNK_SAMPLES;
        const bytes = Buffer.from(chunk.buffer);
        port.postMessage({ type: "audio", buffer: bytes.toString("base64") });
      }
      if (offset < samples.length) {
        remainder = samples.slice(offset);
      }
    });

    audioStream.on("error", (err: Error) => {
      postMessage("stream-error", { error: err.message });
    });

    audioStream.start();
  } catch (err) {
    postMessage("start-failed", { error: (err as Error).message });
    audioStream = null;
  }
}

if (port) {
  port.on("message", (e: { data: { type: string } }) => {
    const msg = e.data;
    if (msg.type === "start") {
      remainder = new Int16Array(0);
      if (!audioStream) initStream();
      streaming = true;
      postMessage("started");
    } else if (msg.type === "stop") {
      streaming = false;
    } else if (msg.type === "exit") {
      streaming = false;
      if (audioStream) {
        try { audioStream.quit(); } catch { /* ignore */ }
        audioStream = null;
      }
      process.exit(0);
    }
  });

  postMessage("ready");
}
