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
  callChatCompletion,
  extractChatText,
} from "@/infra/ai/llm";
import {
  acquireSharedMicrophone,
  setSharedMicrophoneKeepWarm,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import {
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";

const TARGET_SAMPLE_RATE = 16_000;
const PCM_WORKLET_NAME = "stella-dictation-pcm-capture";
const PCM_WORKLET_URL = "/dictation-pcm-worklet.js";
export const DICTATION_SUPER_FAST_KEY = "stella-dictation-super-fast";
export const DICTATION_ENHANCE_KEY = "stella-dictation-enhance";
export const DICTATION_LOCAL_KEY = "stella-dictation-local";
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
const SUPER_FAST_PRE_ROLL_MS = 450;

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

type DictationTranscriptResult = {
  transcript: string;
  source: "local" | "inworld";
};

export function isDictationSuperFastEnabled(): boolean {
  return localStorage.getItem(DICTATION_SUPER_FAST_KEY) === "true";
}

export function isDictationEnhanceEnabled(): boolean {
  return localStorage.getItem(DICTATION_ENHANCE_KEY) === "true";
}

export function isLocalDictationEnabled(): boolean {
  return localStorage.getItem(DICTATION_LOCAL_KEY) === "true";
}

export function setDictationEnhancePreference(enabled: boolean): void {
  localStorage.setItem(DICTATION_ENHANCE_KEY, enabled ? "true" : "false");
}

export function setLocalDictationPreference(enabled: boolean): void {
  localStorage.setItem(DICTATION_LOCAL_KEY, enabled ? "true" : "false");
}

export function setDictationSuperFastPreference(enabled: boolean): void {
  localStorage.setItem(DICTATION_SUPER_FAST_KEY, enabled ? "true" : "false");
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

class DictationWarmCapture {
  private micLease: SharedMicrophoneLease | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;
  private startPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.tearDownAudioPipeline();
    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.micLease?.release();
    this.micLease = null;
    this.chunks = [];
    this.totalSamples = 0;
  }

  snapshot(): Int16Array[] {
    return this.chunks.map((chunk) => chunk.slice());
  }

  private async startInner(): Promise<void> {
    if (this.audioContext && this.micLease) return;
    this.micLease = await acquireSharedMicrophone();
    const ctx = new AudioContext();
    this.audioContext = ctx;
    await ctx.audioWorklet.addModule(PCM_WORKLET_URL);

    const source = ctx.createMediaStreamSource(this.micLease.stream);
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
      if (!samples?.length) return;
      const resampled =
        sourceRate === TARGET_SAMPLE_RATE
          ? samples
          : resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE);
      this.append(floatToInt16Pcm(resampled));
    };
    this.workletNode = worklet;
    source.connect(worklet);
  }

  private append(chunk: Int16Array): void {
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
    const maxSamples = Math.round(
      (SUPER_FAST_PRE_ROLL_MS / 1000) * TARGET_SAMPLE_RATE,
    );
    while (this.totalSamples > maxSamples && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (this.totalSamples - first.length >= maxSamples) {
        this.chunks.shift();
        this.totalSamples -= first.length;
        continue;
      }
      const trim = this.totalSamples - maxSamples;
      this.chunks[0] = first.slice(trim);
      this.totalSamples -= trim;
      break;
    }
  }

  private tearDownAudioPipeline(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.close();
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
  }
}

const warmCapture = new DictationWarmCapture();

export async function setDictationSuperFastModeEnabled(
  enabled: boolean,
): Promise<void> {
  setDictationSuperFastPreference(enabled);
  await setSharedMicrophoneKeepWarm(enabled);
  if (enabled) {
    await warmCapture.start();
  } else {
    await warmCapture.stop();
  }
}

export async function ensureDictationSuperFastWarm(): Promise<void> {
  if (!isDictationSuperFastEnabled()) return;
  await setDictationSuperFastModeEnabled(true);
}

export async function warmLocalDictationModel(): Promise<void> {
  if (window.electronAPI?.platform !== "darwin") return;
  if (!isLocalDictationEnabled()) return;
  await window.electronAPI.dictation?.warmLocal?.();
}

const ENHANCE_TRANSCRIPTION_SYSTEM_PROMPT = `
You clean up raw voice dictation before it is inserted into a text field.

Return only the cleaned text. Do not explain your edits. Do not wrap the result in quotes.

Preserve the user's meaning and intent. If the transcript is already clear, return it unchanged.
Do not summarize, shorten, combine, generalize, or make the text more concise. Keep all requested actions, objects, qualifiers, and framing unless they are filler or an explicit discarded correction.

Clean up:
- filler words and speech sounds such as um, uh, er, hm, ah
- conversational hesitation such as you know, like, I mean, sort of, kind of when it is not meaningful
- false starts, repeated words, repeated phrases, and mid-sentence corrections
- explicit self-corrections by keeping the final intended wording
- dictated punctuation and formatting instructions when obvious

Examples of cleanup:
Input: "uh can you like look at this file for me"
Output: "Can you look at this file for me?"

Input: "I need you to go and do the following for me uh uhm like just go do this first"
Output: "I need you to go and do the following for me: just go do this first."

Input: "this is kind of sort of broken and I mean it crashes when I open settings"
Output: "This is broken, and it crashes when I open settings."

For corrections, prefer the user's latest correction. Remove the abandoned wording, but keep the user's final intent.
Examples of corrections:
Input: "when referring to the model documentation, sorry, I meant the API model documentation. Oh no wait, I meant the API configuration documentation"
Output: "When referring to the API configuration documentation"

Input: "look at the settings file actually no look at the audio settings file"
Output: "Look at the audio settings file."

Input: "make the button blue no wait make it green and keep the same size"
Output: "Make the button green and keep the same size."

When the user dictates paths, commands, code identifiers, filenames, or URLs, normalize them into written technical form:
- "codex slash project slash file dot ts" -> "codex/project/file.ts"
- "API model documentation" may stay as normal prose
- preserve casing for common technical names when clear
Examples of technical normalization:
Input: "look at codex slash projects slash effect dot ts"
Output: "Look at codex/projects/effect.ts."

Input: "run bun run desktop colon type check"
Output: "Run bun run desktop:typecheck."

Input: "open local host colon three thousand slash settings"
Output: "Open localhost:3000/settings."

If the user is listing steps, tasks, instructions, or ordered items, format them as a compact Markdown bullet list.
Treat words such as first, second, third, next, then, finally, also, and after that as strong evidence that the user is listing items.
When formatting a list, preserve the full content of each item. Only remove filler and hesitation. Do not turn a detailed request into a short task summary.
Examples of when to format:
Input: "first understand this project second look at codex slash projects slash effect dot ts and then summarize and explain that concept to me"
Output: "- Understand this project.
- Look at codex/projects/effect.ts.
- Summarize and explain that concept to me."

Input: "I need you to go and do the following for me uh like just go do this first look at codex slash projects slash effect dot ts then I need you to go and summarize it for me and then summarize Stella project"
Output: "I need you to go and do the following for me:
- First, look at codex/projects/effect.ts.
- Then summarize it for me.
- Then summarize Stella project."

Input: "can you check three things the audio settings the microphone permissions and the launcher download step"
Output: "Can you check three things:
- The audio settings.
- The microphone permissions.
- The launcher download step."

Do not format as a list when the user is speaking one normal sentence, even if it contains "and" or "then".
Examples of when not to format:
Input: "look at the audio settings and tell me why the toggle is not saving"
Output: "Look at the audio settings and tell me why the toggle is not saving."

Input: "go into the launcher and check whether the download runs on macOS"
Output: "Go into the launcher and check whether the download runs on macOS."

Do not add facts, commands, filenames, or intent that the user did not say.
`.trim();

const enhanceTranscript = async (transcript: string): Promise<string> => {
  const raw = transcript.trim();
  if (!raw || !isDictationEnhanceEnabled()) return transcript;
  try {
    const response = await callChatCompletion({
      agentType: "dictation",
      messages: [
        {
          role: "system",
          content: ENHANCE_TRANSCRIPTION_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: raw,
        },
      ],
      body: {
        model: "stella/fast",
        max_tokens: Math.min(4000, Math.max(512, raw.length * 2)),
        temperature: 0.1,
      },
    });
    const enhanced = extractChatText(response).trim();
    return enhanced || transcript;
  } catch (error) {
    console.warn(
      "[dictation] enhance transcription failed, using raw transcript:",
      (error as Error).message,
    );
    return transcript;
  }
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
    this.pcmChunks = isDictationSuperFastEnabled()
      ? warmCapture.snapshot()
      : [];

    let lease: SharedMicrophoneLease;
    try {
      lease = await acquireSharedMicrophone();
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
      const result = await this.sendForTranscription(wav);
      const finalTranscript =
        result.source === "local"
          ? await enhanceTranscript(result.transcript)
          : result.transcript;
      this.setState("idle");
      if (finalTranscript) {
        this.callbacks.onFinalTranscript?.(finalTranscript);
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

  private async sendForTranscription(
    wavBytes: Uint8Array,
  ): Promise<DictationTranscriptResult> {
    const audioBase64 = bytesToBase64(wavBytes);
    if (
      window.electronAPI?.platform === "darwin" &&
      isLocalDictationEnabled() &&
      window.electronAPI.dictation?.transcribeLocal
    ) {
      try {
        const local = await window.electronAPI.dictation.transcribeLocal({
          audioBase64,
        });
        return { transcript: local.transcript ?? "", source: "local" };
      } catch (error) {
        console.warn(
          "[dictation] local Parakeet transcription unavailable, falling back:",
          (error as Error).message,
        );
      }
    }

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
    return { transcript: parsed.transcript ?? "", source: "inworld" };
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
