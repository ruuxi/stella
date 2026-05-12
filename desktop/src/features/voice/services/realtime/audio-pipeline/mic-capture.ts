/**
 * Mic capture pipeline for the WebSocket transport.
 *
 * Pulls samples from a MediaStream, downsamples to the target rate (24 kHz by
 * default — what the xAI Voice Agent API expects), converts to 16-bit
 * little-endian PCM, base64-encodes, and hands chunks to a callback.
 *
 * Also exposes:
 *   - An AnalyserNode tap for level visualisation.
 *   - A GainNode for soft-mute (echo guard ramps gain instead of hard-cutting,
 *     matching the WebRTC transport's behaviour).
 *
 * Why ScriptProcessorNode instead of AudioWorklet: AudioWorklet would be
 * lower-jitter but requires bundling a separate worklet module file (Vite
 * `?worker&url`-style), which complicates the build for what is already a
 * stream where ~100 ms chunks are fine. ScriptProcessor is deprecated but
 * still works in every Chromium version Electron ships, and the latency it
 * adds (~10 ms) is comfortably inside the budget for a turn-taking voice
 * agent.
 */

import {
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";

const DEFAULT_TARGET_RATE = 24000;
const DEFAULT_BUFFER_SIZE = 4096;

export interface MicCaptureOptions {
  /** Target PCM sample rate. Must match the session.audio.input.format.rate. */
  targetSampleRate?: number;
  /** ScriptProcessor buffer size. Smaller = lower latency, more CPU. */
  bufferSize?: number;
  /** Called with each PCM16 chunk encoded as base64 (LE). */
  onChunk: (base64Pcm: string) => void;
}

export class MicCapture {
  private readonly targetRate: number;
  private readonly bufferSize: number;
  private readonly onChunk: (base64Pcm: string) => void;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gateGain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muted = false;
  private streaming = false;

  constructor(options: MicCaptureOptions) {
    this.targetRate = options.targetSampleRate ?? DEFAULT_TARGET_RATE;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.onChunk = options.onChunk;
  }

  /** Attach a fresh MediaStream and (re)build the AudioGraph. */
  attach(stream: MediaStream): void {
    this.teardownNodes();

    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    const ctx = this.audioContext;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;

    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = this.muted ? 0 : 1;

    this.source = ctx.createMediaStreamSource(stream);
    this.processor = ctx.createScriptProcessor(this.bufferSize, 1, 1);

    this.source.connect(this.analyser);
    this.source.connect(this.gateGain);
    this.gateGain.connect(this.processor);
    // ScriptProcessor only fires onaudioprocess when connected to the
    // destination. We send a silent stream there — playback isn't the goal.
    this.processor.connect(ctx.destination);

    const sourceRate = ctx.sampleRate;
    const targetRate = this.targetRate;

    this.processor.onaudioprocess = (event) => {
      if (!this.streaming) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled =
        sourceRate === targetRate
          ? input
          : resampleLinear(input, sourceRate, targetRate);
      const pcm16 = floatToInt16Pcm(downsampled);
      this.onChunk(toBase64(pcm16));
    };
  }

  /** Start streaming chunks to the onChunk callback. */
  start(): void {
    this.streaming = true;
  }

  /** Stop streaming chunks (mic graph stays alive for fast resume). */
  stop(): void {
    this.streaming = false;
  }

  /** Soft mute (gain ramp to 0). Streaming continues, just sends silence. */
  setSoftMute(muted: boolean): void {
    this.muted = muted;
    if (!this.gateGain || !this.audioContext) return;
    const target = muted ? 0 : 1;
    const now = this.audioContext.currentTime;
    this.gateGain.gain.cancelScheduledValues(now);
    this.gateGain.gain.setTargetAtTime(target, now, 0.015);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Detach but keep AudioContext alive (cheaper to reattach later). */
  detach(): void {
    this.streaming = false;
    this.teardownNodes();
  }

  /** Tear everything down including the AudioContext. */
  async dispose(): Promise<void> {
    this.streaming = false;
    this.teardownNodes();
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Already closed.
      }
      this.audioContext = null;
    }
  }

  private teardownNodes(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        // Already disconnected.
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // Already disconnected.
      }
      this.source = null;
    }
    if (this.gateGain) {
      try {
        this.gateGain.disconnect();
      } catch {
        // Already disconnected.
      }
      this.gateGain = null;
    }
    this.analyser = null;
  }
}

function toBase64(pcm16: Int16Array): string {
  // Reinterpret the Int16Array buffer as bytes; little-endian on every
  // platform Electron supports.
  const bytes = new Uint8Array(
    pcm16.buffer,
    pcm16.byteOffset,
    pcm16.byteLength,
  );
  let binary = "";
  // Chunked String.fromCharCode to avoid call-stack limits on long streams.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
