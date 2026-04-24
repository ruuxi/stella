/**
 * InworldDictationSession — captures the microphone, buffers downsampled
 * 16 kHz mono PCM, and on stop ships a single WAV-encoded request to our
 * `/api/dictation/transcribe` proxy. The backend forwards to Inworld's
 * sync STT endpoint with Basic auth, so the API key never leaves the
 * server.
 *
 * Why sync HTTP and not the WebSocket: Inworld's STT WebSocket only
 * accepts JWTs in the `Authorization` HEADER. Browser/Electron renderer
 * WebSockets cannot set custom headers, so the streaming flow would
 * either expose the API key or require a stateful WebSocket proxy.
 */

import { postServiceJson } from "@/infra/http/service-request";
import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import {
  encodeInt16ToBase64,
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";

const TARGET_SAMPLE_RATE = 16_000;
const PCM_WORKLET_NAME = "stella-dictation-pcm-capture";
const PCM_WORKLET_URL = "/dictation-pcm-worklet.js";
const DICTATION_MIC_USE_CASE = "dictation" as const;

/** Cap a single dictation segment so the upload stays well under the
 *  backend's 14 MB base64 audio limit. 16 kHz int16 mono = 32 KB/s, so
 *  ~3 minutes of speech ≈ 5.7 MB raw → ~7.6 MB base64 → safely under. */
const MAX_DICTATION_DURATION_MS = 3 * 60 * 1000;

/** How often we emit a level tick to consumers (≈ 12 Hz). The waveform UI
 *  appends one bar per tick, so this also controls the bar density of the
 *  scrolling visualization. */
const LEVEL_EMIT_INTERVAL_MS = 80;

/** RMS values during normal speech sit around 0.05–0.15. Multiplying by
 *  this constant maps that range onto a perceptually pleasing 0–1 scale
 *  for the waveform without immediately clipping at the top. */
const LEVEL_GAIN = 6;

export type DictationSessionState =
  | "idle"
  | "listening"
  | "transcribing"
  | "error";

export type DictationCallbacks = {
  onFinalTranscript?: (text: string) => void;
  onStateChange?: (state: DictationSessionState, error?: string) => void;
  /** Periodic 0..1 input-level tick used by the recording UI to render a
   *  scrolling waveform. Fires at ~12 Hz while listening; the value is the
   *  peak RMS observed since the previous tick. */
  onLevel?: (level: number) => void;
};

type TranscribeResponse = {
  transcript: string;
  isFinal: boolean;
  transcribedAudioMs: number | null;
  modelId: string | null;
};

export class InworldDictationSession {
  private state: DictationSessionState = "idle";
  private micLease: SharedMicrophoneLease | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private callbacks: DictationCallbacks = {};
  /** Concatenated 16 kHz int16 PCM samples captured this session. */
  private pcmChunks: Int16Array[] = [];
  private durationLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  /** Peak RMS seen since the last `onLevel` emit, reset every tick. */
  private peakSinceLastEmit = 0;
  private levelEmitTimer: ReturnType<typeof setInterval> | null = null;

  isActive(): boolean {
    return this.state === "listening" || this.state === "transcribing";
  }

  async start(callbacks: DictationCallbacks): Promise<void> {
    if (this.isActive()) return;
    this.callbacks = callbacks;
    this.cancelled = false;
    this.pcmChunks = [];

    let lease: SharedMicrophoneLease;
    try {
      lease = await acquireSharedMicrophone({
        useCase: DICTATION_MIC_USE_CASE,
      });
    } catch (err) {
      console.error("[dictation] failed to acquire microphone:", err);
      this.setState("error", (err as Error).message);
      await this.cleanup();
      throw err;
    }
    this.micLease = lease;

    try {
      await this.setupAudioPipeline(lease.stream);
      this.durationLimitTimer = setTimeout(() => {
        console.warn(
          "[dictation] hit max segment duration, auto-stopping",
        );
        void this.stop();
      }, MAX_DICTATION_DURATION_MS);
      this.startLevelEmitter();
      this.setState("listening");
      console.log("[dictation] listening (capturing PCM)");
    } catch (err) {
      console.error("[dictation] failed to start audio pipeline:", err);
      this.setState("error", (err as Error).message);
      await this.cleanup();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "transcribing") return;

    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    this.stopLevelEmitter();

    this.tearDownAudioPipeline();
    if (this.micLease) {
      try {
        this.micLease.release();
      } catch {
        // ignore
      }
      this.micLease = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    if (this.cancelled) {
      this.pcmChunks = [];
      this.setState("idle");
      return;
    }

    const totalSamples = this.pcmChunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
    if (totalSamples === 0) {
      console.log("[dictation] no audio captured, skipping upload");
      this.setState("idle");
      return;
    }

    this.setState("transcribing");
    const durationMs = Math.round(
      (totalSamples / TARGET_SAMPLE_RATE) * 1000,
    );
    console.log(
      `[dictation] uploading ${totalSamples} samples (${durationMs}ms)`,
    );

    try {
      const wav = encodeWav16(this.pcmChunks, TARGET_SAMPLE_RATE);
      this.pcmChunks = [];
      const transcript = await this.sendForTranscription(wav);
      this.setState("idle");
      if (transcript) {
        this.callbacks.onFinalTranscript?.(transcript);
      }
    } catch (err) {
      console.error("[dictation] transcription failed:", err);
      this.setState("error", (err as Error).message);
    }
  }

  /** Stop without uploading. Used on unmount / error paths. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.stop();
  }

  private async sendForTranscription(wavBytes: Uint8Array): Promise<string> {
    const audioBase64 = encodeInt16ToBase64(
      new Int16Array(
        wavBytes.buffer,
        wavBytes.byteOffset,
        wavBytes.byteLength / 2,
      ),
    );
    const parsed = await postServiceJson<TranscribeResponse>(
      "/api/dictation/transcribe",
      {
        audioBase64,
        audioEncoding: "AUTO_DETECT",
      },
      {
        errorMessage: async (response) => {
          const detail = await response.text();
          return `Transcription failed: ${response.status} ${detail}`;
        },
      },
    );
    return parsed.transcript ?? "";
  }

  private async setupAudioPipeline(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext();
    this.audioContext = ctx;

    await ctx.audioWorklet.addModule(PCM_WORKLET_URL);

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;

    const worklet = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    const sourceRate = ctx.sampleRate;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      if (!samples || samples.length === 0) return;

      // Cheap RMS over the raw chunk for the level meter — feeds the
      // scrolling waveform UI without allocating anything.
      let sumSq = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      if (rms > this.peakSinceLastEmit) this.peakSinceLastEmit = rms;

      const resampled =
        sourceRate === TARGET_SAMPLE_RATE
          ? samples
          : resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE);
      this.pcmChunks.push(floatToInt16Pcm(resampled));
    };
    this.workletNode = worklet;

    source.connect(worklet);
  }

  private tearDownAudioPipeline(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.port.close();
      } catch {
        // ignore
      }
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
  }

  private async cleanup(): Promise<void> {
    this.tearDownAudioPipeline();
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
    if (this.micLease) {
      try {
        this.micLease.release();
      } catch {
        // ignore
      }
      this.micLease = null;
    }
    if (this.durationLimitTimer) {
      clearTimeout(this.durationLimitTimer);
      this.durationLimitTimer = null;
    }
    this.stopLevelEmitter();
  }

  private startLevelEmitter(): void {
    this.stopLevelEmitter();
    this.peakSinceLastEmit = 0;
    this.levelEmitTimer = setInterval(() => {
      const level = Math.min(1, this.peakSinceLastEmit * LEVEL_GAIN);
      this.peakSinceLastEmit = 0;
      this.callbacks.onLevel?.(level);
    }, LEVEL_EMIT_INTERVAL_MS);
  }

  private stopLevelEmitter(): void {
    if (this.levelEmitTimer) {
      clearInterval(this.levelEmitTimer);
      this.levelEmitTimer = null;
    }
    this.peakSinceLastEmit = 0;
  }

  private setState(state: DictationSessionState, error?: string): void {
    this.state = state;
    this.callbacks.onStateChange?.(state, error);
  }
}

// ---------------------------------------------------------------------------
// WAV encoding — Inworld's sync STT requires a container (WAV/MP3/OGG/FLAC),
// raw LINEAR16 isn't accepted on this endpoint.
// ---------------------------------------------------------------------------

const encodeWav16 = (
  chunks: Int16Array[],
  sampleRate: number,
): Uint8Array => {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const dataSize = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      view.setInt16(offset, chunk[i]!, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
};

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
};
