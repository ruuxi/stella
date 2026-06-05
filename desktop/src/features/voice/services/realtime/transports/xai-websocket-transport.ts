/**
 * xAI Voice Agent WebSocket transport.
 *
 * xAI's Voice Agent API is OpenAI-Realtime-compatible at the event level but
 * uses a WebSocket (no WebRTC). That means we hand-roll what WebRTC was
 * doing for free: capture mic samples → resample to 24 kHz PCM16 → base64 →
 * `input_audio_buffer.append`; receive `response.output_audio.delta` →
 * decode PCM16 → schedule on AudioContext.
 *
 * Differences from OpenAI's event vocabulary that this transport
 * normalises before passing events upstream:
 *   - `response.text.delta` → `response.output_text.delta` (xAI uses the
 *     OpenAI beta event name).
 *   - Synthesises `output_audio.started` / `output_audio.done` from the
 *     PCM player's queue state so the session's echo guard works
 *     identically to the WebRTC path.
 *
 * Auth: WebSocket subprotocol `xai-client-secret.<token>` (browser
 * WebSocket can't send headers). The clientSecret is minted in main by
 * the xai-provider module; this transport just uses whatever was handed
 * to it.
 */

import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { MicCapture } from "../audio-pipeline/mic-capture";
import { PcmPlayer } from "../audio-pipeline/pcm-player";
import type {
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportProvider,
} from "./types";
import type { RealtimeSessionTool } from "../providers/types";

const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
const SUBPROTOCOL_PREFIX = "xai-client-secret.";
const DEFAULT_INPUT_RATE = 24000;
const DEFAULT_OUTPUT_RATE = 24000;
const PCM16_BYTES_PER_SAMPLE = 2;

const estimateBase64Pcm16Seconds = (
  base64: string,
  sampleRate: number,
): number => {
  if (!base64 || sampleRate <= 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return byteLength / PCM16_BYTES_PER_SAMPLE / sampleRate;
};

const isBillableTextInputItem = (item: unknown): boolean => {
  if (!item || typeof item !== "object") return true;
  const record = item as Record<string, unknown>;
  if (record.type === "function_call_output") return false;

  const content = record.content;
  if (!Array.isArray(content)) return true;
  return !content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as Record<string, unknown>).type;
    return type === "input_audio" || type === "audio";
  });
};

export interface XaiWebSocketTransportOptions {
  clientSecret: string;
  model: string;
  voice: string;
  instructions?: string;
  tools?: RealtimeSessionTool[];
  inputSampleRate?: number;
  outputSampleRate?: number;
}

export class XaiWebSocketTransport implements RealtimeTransport {
  readonly provider: RealtimeTransportProvider = "xai";
  readonly model: string;

  private readonly clientSecret: string;
  private readonly voice: string;
  private readonly instructions?: string;
  private readonly tools?: RealtimeSessionTool[];
  private readonly inputRate: number;
  private readonly outputRate: number;

  private ws: WebSocket | null = null;
  private mic: MicCapture;
  private player: PcmPlayer;

  private micLease: SharedMicrophoneLease | null = null;
  private micStream: MediaStream | null = null;
  private micEnabled = false;
  private micSyncPromise: Promise<void> = Promise.resolve();
  private destroyed = false;

  private events: RealtimeTransportEvents | null = null;
  private inputAudioSecondsSinceLastResponse = 0;
  private outputAudioSecondsSinceLastResponse = 0;
  private textInputMessagesSinceLastResponse = 0;

  constructor(options: XaiWebSocketTransportOptions) {
    this.clientSecret = options.clientSecret;
    this.model = options.model;
    this.voice = options.voice;
    this.instructions = options.instructions;
    this.tools = options.tools;
    this.inputRate = options.inputSampleRate ?? DEFAULT_INPUT_RATE;
    this.outputRate = options.outputSampleRate ?? DEFAULT_OUTPUT_RATE;

    this.mic = new MicCapture({
      targetSampleRate: this.inputRate,
      onChunk: (base64Pcm) => {
        this.inputAudioSecondsSinceLastResponse += estimateBase64Pcm16Seconds(
          base64Pcm,
          this.inputRate,
        );
        this.sendRaw({
          type: "input_audio_buffer.append",
          audio: base64Pcm,
        });
      },
    });

    this.player = new PcmPlayer({
      inputSampleRate: this.outputRate,
      onSpeakingStart: () => {
        this.events?.onEvent({ type: "output_audio.started" });
      },
      onSpeakingEnd: () => {
        this.events?.onEvent({ type: "output_audio.done" });
      },
    });
  }

  async connect(events: RealtimeTransportEvents): Promise<void> {
    this.events = events;

    const url = `${XAI_REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
    const ws = new WebSocket(url, [
      `${SUBPROTOCOL_PREFIX}${this.clientSecret}`,
    ]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (event: Event) => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        const message =
          (event as ErrorEvent).message ||
          "Failed to open xAI realtime WebSocket";
        reject(new Error(message));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    if (this.destroyed) return;

    ws.addEventListener("message", (event) => {
      this.handleRawMessage(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (this.destroyed) return;
      this.events?.onClose(
        `xAI WebSocket closed (${event.code} ${event.reason || ""})`.trim(),
      );
    });
    ws.addEventListener("error", () => {
      if (this.destroyed) return;
      this.events?.onClose("xAI WebSocket error");
    });

    this.sendRaw({
      type: "session.update",
      session: {
        voice: this.voice,
        ...(this.instructions ? { instructions: this.instructions } : {}),
        ...(this.tools?.length
          ? { tools: this.tools, tool_choice: "auto" }
          : {}),
        turn_detection: { type: "server_vad" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: this.inputRate },
          },
          output: {
            format: { type: "audio/pcm", rate: this.outputRate },
          },
        },
      },
    });

    await this.syncMicState();
  }

  send(event: Record<string, unknown>): void {
    if (event.type === "conversation.item.truncate") {
      // xAI doesn't support truncate; flushing local playback is the
      // closest analogue and matches user-visible behaviour (assistant
      // stops talking immediately).
      this.player.flush();
      return;
    }
    this.sendRaw(event);
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    return this.syncMicState();
  }

  applySoftInputMute(muted: boolean): void {
    this.mic.setSoftMute(muted);
  }

  getMicAnalyser(): AnalyserNode | null {
    return this.mic.getAnalyser();
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.player.getAnalyser();
  }

  interruptPlayback(): void {
    this.player.flush();
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.events = null;

    this.mic.stop();
    this.mic.detach();
    await this.mic.dispose();
    await this.player.dispose();

    this.releaseMicrophoneCapture();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed.
      }
      this.ws = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  private sendRaw(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const isBillableTextInput =
        event.type === "conversation.item.create" &&
        isBillableTextInputItem(event.item);
      this.ws.send(JSON.stringify(event));
      if (isBillableTextInput) this.textInputMessagesSinceLastResponse += 1;
    } catch (err) {
      console.debug("[xai-ws] Failed to send event:", (err as Error).message);
    }
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      console.debug(
        "[xai-ws] Failed to parse server event:",
        (err as Error).message,
      );
      return;
    }
    const type = parsed.type;

    // Audio deltas go straight to the PCM player; the session class
    // doesn't need to see them. The player's queue state drives our
    // synthesised speaking-start / speaking-end events.
    if (type === "response.output_audio.delta") {
      const audio = parsed.delta ?? parsed.audio;
      if (typeof audio === "string" && audio.length > 0) {
        this.outputAudioSecondsSinceLastResponse += estimateBase64Pcm16Seconds(
          audio,
          this.outputRate,
        );
        this.player.pushBase64Pcm16(audio);
      }
      return;
    }

    if (type === "response.done") {
      this.events?.onEvent(this.withUsageAccounting(parsed));
      return;
    }

    // Normalise xAI's beta text-delta name onto OpenAI's GA name so the
    // session class only needs one vocabulary.
    if (type === "response.text.delta") {
      this.events?.onEvent({ ...parsed, type: "response.output_text.delta" });
      return;
    }

    this.events?.onEvent(parsed);
  }

  private withUsageAccounting(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const response = event.response;
    const inputAudioSeconds = this.inputAudioSecondsSinceLastResponse;
    const outputAudioSeconds = this.outputAudioSecondsSinceLastResponse;
    const textInputMessages = this.textInputMessagesSinceLastResponse;
    this.inputAudioSecondsSinceLastResponse = 0;
    this.outputAudioSecondsSinceLastResponse = 0;
    this.textInputMessagesSinceLastResponse = 0;

    if (!response || typeof response !== "object") return event;
    const responseRecord = response as Record<string, unknown>;
    const usage =
      responseRecord.usage && typeof responseRecord.usage === "object"
        ? (responseRecord.usage as Record<string, unknown>)
        : {};
    const audioSeconds = inputAudioSeconds + outputAudioSeconds;
    return {
      ...event,
      response: {
        ...responseRecord,
        usage: {
          ...usage,
          xai: {
            ...(usage.xai && typeof usage.xai === "object"
              ? (usage.xai as Record<string, unknown>)
              : {}),
            audio_seconds: audioSeconds,
            audio_input_seconds: inputAudioSeconds,
            audio_output_seconds: outputAudioSeconds,
            text_input_messages: textInputMessages,
          },
        },
      },
    };
  }

  private syncMicState(): Promise<void> {
    this.micSyncPromise = this.micSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (this.destroyed) return;
        if (this.micEnabled) {
          await this.resumeMicrophoneCapture();
          if (!this.micEnabled || this.destroyed) {
            await this.suspendMicrophoneCapture();
          }
          return;
        }
        await this.suspendMicrophoneCapture();
      });
    return this.micSyncPromise;
  }

  private async resumeMicrophoneCapture(): Promise<void> {
    if (!this.micEnabled || this.destroyed) return;

    if (!this.micStream) {
      const lease = await acquireSharedMicrophone();
      if (!this.micEnabled || this.destroyed) {
        lease.release();
        return;
      }
      this.micLease = lease;
      this.micStream = lease.stream;
      this.mic.attach(lease.stream);
    }

    this.mic.start();
  }

  private async suspendMicrophoneCapture(): Promise<void> {
    this.mic.stop();
    if (!this.micStream && !this.micLease) {
      this.mic.setSoftMute(false);
      return;
    }
    // Clear xAI's server-side buffer so any accidental tail samples
    // don't get committed as the user's next utterance.
    this.sendRaw({ type: "input_audio_buffer.clear" });
    this.releaseMicrophoneCapture();
  }

  private releaseMicrophoneCapture(): void {
    this.mic.detach();
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.micLease) {
      this.micLease.release();
      this.micLease = null;
    }
  }
}
