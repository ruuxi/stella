/**
 * RealtimeVoiceSession — WebRTC session manager for OpenAI Realtime API.
 *
 * Manages the full lifecycle of a voice-to-voice session:
 * - WebRTC peer connection + audio I/O
 * - Data channel for sending/receiving JSON events
 * - Single-tool delegation to the orchestrator via Electron IPC
 * - Conversation transcript logging
 */

import { createServiceRequest } from "./http/service-request";
import type { NeriWindowType } from "@/app/neri/neri-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disconnecting";

export type VoiceSessionEvent =
  | { type: "state-change"; state: VoiceSessionState; error?: string }
  | { type: "user-transcript"; text: string; isFinal: boolean }
  | { type: "assistant-transcript"; text: string; isFinal: boolean }
  | { type: "tool-start"; name: string; callId: string }
  | { type: "tool-end"; name: string; callId: string; result: string }
  | { type: "speaking-start" }
  | { type: "speaking-end" }
  | { type: "user-speaking-start" }
  | { type: "user-speaking-end" };

type VoiceSessionListener = (event: VoiceSessionEvent) => void;

// ---------------------------------------------------------------------------
// Token pre-fetch cache: keeps a fresh ephemeral token while wake word listens
// ---------------------------------------------------------------------------

type CachedToken = {
  clientSecret: string;
  model: string;
  voice: string;
  expiresAt?: number;
};

type VoiceRuntimeState = {
  activeSession: { disconnect: () => Promise<void> } | null;
  onPreWarm?: (conversationId: string) => void;
  onPrefetch?: () => void;
  preWarmUnsubscribe?: () => void;
  prefetchUnsubscribe?: () => void;
};

const VOICE_RUNTIME_STATE_KEY = "__stellaRealtimeVoiceRuntimeState";

const getVoiceRuntimeState = (): VoiceRuntimeState => {
  const root = globalThis as typeof globalThis & {
    [VOICE_RUNTIME_STATE_KEY]?: VoiceRuntimeState;
  };
  if (!root[VOICE_RUNTIME_STATE_KEY]) {
    root[VOICE_RUNTIME_STATE_KEY] = {
      activeSession: null,
    };
  }
  return root[VOICE_RUNTIME_STATE_KEY];
};

let cachedToken: CachedToken | null = null;
const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;
const PRECONNECT_BUFFER_CHUNK_LIMIT = 36; // ~3s at 24kHz with 2048-sample chunks
const PRECONNECT_SPEECH_RMS_THRESHOLD = 0.012;
const PRECONNECT_SILENCE_MS = 280;
const PRECONNECT_BOUNDARY_MAX_WAIT_MS = 1800;
const PRECONNECT_BOUNDARY_POLL_MS = 40;
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 8_000;

const RTC_CONFIGURATION: RTCConfiguration = {
  // Pre-gather one ICE candidate batch to shorten negotiation time.
  iceCandidatePoolSize: 1,
};

const VOICE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const NERI_WINDOW_TYPES: ReadonlySet<NeriWindowType> = new Set([
  "news-feed",
  "music-player",
  "ai-search",
  "calendar",
  "game",
  "system-monitor",
  "weather",
  "notes",
  "file-browser",
  "search",
  "canvas",
]);

const isNeriWindowType = (value: string): value is NeriWindowType =>
  NERI_WINDOW_TYPES.has(value as NeriWindowType);

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

const buildVoiceSessionRequestBody = (
  conversationId?: string,
): { conversationId?: string } => {
  const convexConversationId = toConvexConversationId(conversationId);
  return convexConversationId ? { conversationId: convexConversationId } : {};
};

async function prefetchToken(): Promise<void> {
  try {
    const { endpoint, headers } = await createServiceRequest("/api/voice/session");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(buildVoiceSessionRequestBody()),
    });
    if (!res.ok) return;
    const data = await res.json();
    // Only cache if token has >10s of remaining validity
    if (!data.expiresAt || (data.expiresAt * 1000 - Date.now()) < 10_000) return;
    cachedToken = data;
  } catch (err) {
    console.debug("[realtime-voice] Token pre-fetch failed:", (err as Error).message);
  }
}

const TOKEN_MIN_REMAINING_MS = 5_000;

function consumeCachedToken(): CachedToken | null {
  const t = cachedToken;
  cachedToken = null;
  if (!t) return null;
  // Discard if no expiry info or <5s remaining (not enough for SDP exchange)
  if (!t.expiresAt) return null;
  if (t.expiresAt * 1000 - Date.now() < TOKEN_MIN_REMAINING_MS) return null;
  return t;
}

// ---------------------------------------------------------------------------
// Pre-warm: start connection from IPC before React lifecycle kicks in
// ---------------------------------------------------------------------------

let preWarmedSession: RealtimeVoiceSession | null = null;
let preWarmConvId: string | null = null;

/**
 * Immediately create a session and start connecting. Called from an IPC
 * handler so the token fetch + mic + SDP pipeline begins before React renders.
 */
export function preWarmVoiceSession(conversationId: string): void {
  const runtime = getVoiceRuntimeState();
  if (runtime.activeSession) {
    // Persistent session already active; no need for wake-time pre-warm.
    return;
  }
  if (preWarmedSession) {
    if (preWarmConvId === conversationId) return;
    void preWarmedSession.disconnect();
    preWarmedSession = null;
    preWarmConvId = null;
  }
  const session = new RealtimeVoiceSession();
  preWarmedSession = session;
  preWarmConvId = conversationId;
  const token = consumeCachedToken() ?? undefined;
  session.connect(conversationId, token).catch(() => {
    if (preWarmedSession === session) {
      preWarmedSession = null;
      preWarmConvId = null;
    }
  });
}

/**
 * Claim a pre-warmed session. Returns null if none exists or if the
 * conversationId doesn't match.
 */
export function claimPreWarmedSession(
  conversationId: string
): RealtimeVoiceSession | null {
  if (!preWarmedSession) return null;
  if (preWarmConvId !== conversationId) {
    void preWarmedSession.disconnect();
    preWarmedSession = null;
    preWarmConvId = null;
    return null;
  }
  const session = preWarmedSession;
  preWarmedSession = null;
  preWarmConvId = null;
  return session;
}

let ipcInitialized = false;

export function initRealtimeVoiceIpc(): void {
  if (ipcInitialized) return;
  ipcInitialized = true;

  const runtime = getVoiceRuntimeState();
  runtime.onPreWarm = (conversationId: string) => {
    preWarmVoiceSession(conversationId);
  };
  runtime.onPrefetch = () => {
    void prefetchToken();
  };

  const api = window.electronAPI;

  if (api?.voice.onRtcPreWarm && !runtime.preWarmUnsubscribe) {
    runtime.preWarmUnsubscribe = api.voice.onRtcPreWarm((conversationId: string) => {
      runtime.onPreWarm?.(conversationId);
    });
  }

  if (api?.voice.onRtcPrefetchToken && !runtime.prefetchUnsubscribe) {
    runtime.prefetchUnsubscribe = api.voice.onRtcPrefetchToken(() => {
      runtime.onPrefetch?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputAudioContext: AudioContext | null = null;
  private destroyed = false;
  private inputActive = false;

  // Pre-connection audio buffer — captures mic audio while SDP negotiation is in progress
  private preConnectBuffer: string[] = []; // base64-encoded PCM chunks
  private preConnectRecorder: ScriptProcessorNode | null = null;
  private preConnectCtx: AudioContext | null = null;
  private isBufferingPreConnect = false;
  private preConnectObservedSpeech = false;
  private preConnectLastSpeechAt = 0;
  private dataChannelOpenPromise: Promise<void> | null = null;
  private resolveDataChannelOpenPromise: (() => void) | null = null;

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;

  // Accumulated transcript fragments
  private assistantTranscriptBuffer = "";
  private lastUserTranscript = "";

  // Conversation trace log — sequential record of every event for debugging
  private static readonly MAX_TRACE_ENTRIES = 500;
  private traceLog: Array<{ seq: number; time: number; event: string; detail: string }> = [];
  private traceSeq = 0;

  private trace(event: string, detail: string) {
    this.traceSeq++;
    if (this.traceLog.length >= RealtimeVoiceSession.MAX_TRACE_ENTRIES) {
      this.traceLog.shift();
    }
    this.traceLog.push({ seq: this.traceSeq, time: Date.now(), event, detail });
  }

  /** Return the full conversation trace for debugging. */
  dumpTrace(): Array<{ seq: number; time: number; event: string; detail: string }> {
    return [...this.traceLog];
  }

  get state(): VoiceSessionState {
    return this._state;
  }

  setConversationId(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Toggle whether mic audio is actively sent to Realtime.
   * Session stays connected; we only gate the input track.
   */
  setInputActive(active: boolean) {
    this.inputActive = active;
    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = active;
    }
    if (active && this.localStream && !this.inputTrack && !this.isBufferingPreConnect) {
      this.startPreConnectBuffering(this.localStream);
    }
    if (!active && this.isBufferingPreConnect) {
      this.stopPreConnectBuffering();
    }
  }

  // ---------------------------------------------------------------------------
  // Event emitter
  // ---------------------------------------------------------------------------

  on(listener: VoiceSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceSessionEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.debug("[realtime-voice] Listener error:", (err as Error).message);
      }
    }
  }

  private setState(state: VoiceSessionState, error?: string) {
    this._state = state;
    this.emit({ type: "state-change", state, error });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async connect(
    conversationId: string,
    prefetchedToken?: CachedToken,
  ): Promise<void> {
    const runtime = getVoiceRuntimeState();
    if (runtime.activeSession && runtime.activeSession !== this) {
      await runtime.activeSession.disconnect().catch((err) => {
        console.debug('[RealtimeVoice] Previous session disconnect failed:', (err as Error).message);
      });
    }
    runtime.activeSession = this;

    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      // ── Phase 1: Start ALL work in parallel ────────────────────────

      // A) Use pre-fetched token if available, otherwise fetch inline
      const keyPromise = prefetchedToken
        ? Promise.resolve(prefetchedToken)
        : (async () => {
        const { endpoint, headers } = await createServiceRequest("/api/voice/session");
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(buildVoiceSessionRequestBody(conversationId)),
        });
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Failed to create voice session: ${res.status} ${detail}`);
        }
        return (await res.json()) as CachedToken;
      })();

      // B) Acquire microphone (runs in parallel, awaited later)
      // Start pre-connect buffering as soon as mic is available so user speech
      // during SDP negotiation is captured and flushed when the channel opens.
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: VOICE_MIC_CONSTRAINTS,
      }).then((stream) => {
        if (!this.destroyed && this.inputActive) {
          this.startPreConnectBuffering(stream);
        }
        return stream;
      });
      micPromise.catch((err) => {
        console.debug('[RealtimeVoice] Mic access failed (non-blocking):', (err as Error).message);
      });

      // C) Create RTCPeerConnection + SDP offer locally (no network, no mic needed)
      this.pc = new RTCPeerConnection(RTC_CONFIGURATION);
      const transceiver = this.pc.addTransceiver("audio", { direction: "sendrecv" });

      this.dc = this.pc.createDataChannel("oai-events");
      this.initDataChannelOpenLatch();
      this.setupDataChannel();

      this.pc.ontrack = (event) => {
        if (this.destroyed) return;
        const remoteStream = event.streams[0];
        if (remoteStream) {
          this.setupAudioPlayback(remoteStream);
        }
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (this.destroyed) { this.cleanup(); return; }

      // ── Phase 2: SDP exchange — needs token, NOT mic ───────────────
      const keyResult = await keyPromise;
      if (this.destroyed) { this.cleanup(); return; }

      const { clientSecret, model } = keyResult;

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        }
      );
      if (this.destroyed) { this.cleanup(); return; }

      if (!sdpResponse.ok) {
        throw new Error(
          `SDP negotiation failed: ${sdpResponse.status} ${await sdpResponse.text()}`
        );
      }

      const answerSdp = await sdpResponse.text();
      await this.pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
      if (this.destroyed) { this.cleanup(); return; }

      // ── Phase 3: Attach mic track (likely already resolved) ────────
      const micStream = await micPromise;
      if (this.destroyed) {
        micStream.getTracks().forEach((t) => t.stop());
        this.cleanup();
        return;
      }
      this.localStream = micStream;
      this.inputTrack = micStream.getTracks()[0] ?? null;
      if (!this.inputTrack) {
        throw new Error("No microphone track available");
      }

      if (this.inputActive) {
        if (!this.isBufferingPreConnect) {
          this.startPreConnectBuffering(micStream);
        }
        await this.waitForDataChannelOpen();
        await this.waitForFirstTurnBoundary();

        const bufferedChunks = this.consumePreConnectBuffer();
        this.flushPreConnectChunks(bufferedChunks);
      } else {
        this.stopPreConnectBuffering();
      }

      this.inputTrack.enabled = this.inputActive;
      await transceiver.sender.replaceTrack(this.inputTrack);

      // Setup audio analyser for visualization
      this.setupAudioAnalyser();

      this.trace("CONNECTED", `conv=${conversationId} prefetched=${!!prefetchedToken}`);
      this.setState("connected");
    } catch (err) {
      if (this.destroyed) return;
      this.cleanup();
      const runtime = getVoiceRuntimeState();
      if (runtime.activeSession === this) {
        runtime.activeSession = null;
      }
      this.setState("error", (err as Error).message);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._state === "idle" || this._state === "disconnecting") return;
    this.trace("DISCONNECT", "session ending");
    this.dumpTrace();
    this.destroyed = true;
    const runtime = getVoiceRuntimeState();
    if (runtime.activeSession === this) {
      runtime.activeSession = null;
    }
    this.setState("disconnecting");
    this.cleanup();
    this.setState("idle");
  }

  /** Get the mic input analyser node for visualization. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Get the output (assistant voice) analyser node for visualization. */
  getOutputAnalyser(): AnalyserNode | null {
    return this.outputAnalyser;
  }

  // ---------------------------------------------------------------------------
  // WebRTC internals
  // ---------------------------------------------------------------------------

  /** Start capturing mic audio into a buffer while we wait for the data channel. */
  private startPreConnectBuffering(micStream: MediaStream) {
    if (this.isBufferingPreConnect) return;
    this.isBufferingPreConnect = true;
    this.preConnectBuffer = [];
    this.preConnectObservedSpeech = false;
    this.preConnectLastSpeechAt = Date.now();

    try {
      const ctx = new AudioContext({ sampleRate: 24000 }); // OpenAI Realtime expects 24kHz
      this.preConnectCtx = ctx;
      const source = ctx.createMediaStreamSource(micStream);

      // ScriptProcessorNode to capture raw PCM (deprecated but universally supported)
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      this.preConnectRecorder = processor;

      processor.onaudioprocess = (e) => {
        if (!this.isBufferingPreConnect) return;
        const float32 = e.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        // Convert to 16-bit PCM then base64 (matching OpenAI's input_audio_buffer.append format)
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const sample = float32[i];
          sumSquares += sample * sample;
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, float32.length));
        if (rms >= PRECONNECT_SPEECH_RMS_THRESHOLD) {
          this.preConnectObservedSpeech = true;
          this.preConnectLastSpeechAt = Date.now();
        }
        const bytes = new Uint8Array(int16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        if (this.preConnectBuffer.length >= PRECONNECT_BUFFER_CHUNK_LIMIT) {
          // Keep the freshest speech to avoid large stale-audio backlogs.
          this.preConnectBuffer.shift();
        }
        this.preConnectBuffer.push(btoa(binary));
      };

      source.connect(processor);
      processor.connect(ctx.destination); // required for ScriptProcessorNode to fire
    } catch (err) {
      console.debug("[realtime-voice] Pre-connect buffering setup failed:", (err as Error).message);
      this.isBufferingPreConnect = false;
    }
  }

  /** Stop pre-connect buffering and clean up the capture nodes. */
  private stopPreConnectBuffering() {
    this.isBufferingPreConnect = false;
    if (this.preConnectRecorder) {
      this.preConnectRecorder.disconnect();
      this.preConnectRecorder = null;
    }
    if (this.preConnectCtx) {
      this.preConnectCtx.close().catch((err) => {
        console.debug('[RealtimeVoice] Pre-connect audio context close failed:', (err as Error).message);
      });
      this.preConnectCtx = null;
    }
  }

  private consumePreConnectBuffer(): string[] {
    const chunks = this.preConnectBuffer;
    this.stopPreConnectBuffering();
    this.preConnectBuffer = [];
    return chunks;
  }

  /** Flush buffered pre-connect audio into the Realtime API via the data channel. */
  private flushPreConnectChunks(chunks: string[]) {
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      this.sendEvent({
        type: "input_audio_buffer.append",
        audio: chunk,
      });
    }
  }

  private initDataChannelOpenLatch() {
    this.dataChannelOpenPromise = new Promise<void>((resolve) => {
      this.resolveDataChannelOpenPromise = resolve;
    });
  }

  private markDataChannelOpen() {
    if (this.resolveDataChannelOpenPromise) {
      this.resolveDataChannelOpenPromise();
      this.resolveDataChannelOpenPromise = null;
    }
  }

  private async waitForDataChannelOpen(): Promise<void> {
    if (this.dc?.readyState === "open") return;
    if (!this.dataChannelOpenPromise) {
      this.initDataChannelOpenLatch();
    }
    const latch = this.dataChannelOpenPromise!;
    await Promise.race([
      latch,
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for data channel to open"));
        }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
        latch.finally(() => clearTimeout(timeout));
      }),
    ]);
  }

  private async waitForFirstTurnBoundary(): Promise<void> {
    if (!this.isBufferingPreConnect || this.preConnectBuffer.length === 0) return;
    if (!this.preConnectObservedSpeech) return;

    const startedAt = Date.now();
    while (!this.destroyed && this.isBufferingPreConnect) {
      const now = Date.now();
      const elapsed = now - startedAt;
      const silenceFor = now - this.preConnectLastSpeechAt;

      if (this.preConnectObservedSpeech && silenceFor >= PRECONNECT_SILENCE_MS) {
        return;
      }
      if (elapsed >= PRECONNECT_BOUNDARY_MAX_WAIT_MS) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PRECONNECT_BOUNDARY_POLL_MS));
    }
  }

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {
      this.markDataChannelOpen();
    };

    this.dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleServerEvent(data);
      } catch (err) {
        console.debug("[realtime-voice] Failed to parse data channel message:", (err as Error).message);
      }
    };

    this.dc.onclose = () => {
      if (this._state === "connected") {
        this.cleanup();
        this.setState("error", "Connection lost");
      }
    };

    this.dc.onerror = () => {};

  }

  private setupAudioPlayback(stream: MediaStream) {
    if (this.destroyed) return;

    // Guard against duplicate ontrack — only set up playback once
    if (this.audioElement) return;

    this.audioElement = new Audio();
    this.audioElement.srcObject = stream;
    this.audioElement.autoplay = true;
    this.audioElement.play().catch((err) => {
      console.debug('[RealtimeVoice] Audio playback failed:', (err as Error).message);
    });

    // Create analyser for the output (assistant) audio stream.
    // Don't connect to destination — the Audio element handles playback.
    try {
      this.outputAudioContext = new AudioContext();
      this.outputAnalyser = this.outputAudioContext.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      const source = this.outputAudioContext.createMediaStreamSource(stream);
      source.connect(this.outputAnalyser);
    } catch (err) {
      console.debug("[realtime-voice] Output analyser setup failed:", (err as Error).message);
    }
  }

  private setupAudioAnalyser() {
    if (!this.localStream) return;
    try {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      source.connect(this.analyser);
    } catch (err) {
      console.debug("[realtime-voice] Analyser setup failed:", (err as Error).message);
    }
  }

  private sendEvent(event: Record<string, unknown>) {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(event));
    }
  }

  // ---------------------------------------------------------------------------
  // Server event handling
  // ---------------------------------------------------------------------------

  private handleServerEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    switch (type) {
      case "session.created":
        this.trace("SESSION", "created");
        break;
      case "session.updated":
        this.trace("SESSION", "updated");
        break;

      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          this.trace("TOOL_CALL", `${item.name}(${String(item.arguments ?? "").slice(0, 200)})`);
          void this.handleFunctionCall(item);
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
          this.assistantTranscriptBuffer += delta;
          this.emit({
            type: "assistant-transcript",
            text: delta,
            isFinal: false,
          });
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
          this.trace("ASSISTANT_MSG", transcript);
          this.emit({
            type: "assistant-transcript",
            text: transcript,
            isFinal: true,
          });
          this.assistantTranscriptBuffer = "";
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
          this.lastUserTranscript = transcript;
          this.trace("USER_MSG", transcript);
          this.emit({
            type: "user-transcript",
            text: transcript,
            isFinal: true,
          });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.delta": {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
          this.emit({
            type: "user-transcript",
            text: delta,
            isFinal: false,
          });
        }
        break;
      }

      case "output_audio.started":
        this.emit({ type: "speaking-start" });
        break;

      case "output_audio.done":
        this.emit({ type: "speaking-end" });
        break;

      case "input_audio_buffer.speech_started":
        this.emit({ type: "user-speaking-start" });
        break;

      case "input_audio_buffer.speech_stopped":
        this.emit({ type: "user-speaking-end" });
        break;

      case "response.done": {
        // Log whether the model used a tool or just spoke
        const output = (event as Record<string, unknown>).response as Record<string, unknown> | undefined;
        const outputItems = (output?.output as Array<Record<string, unknown>>) ?? [];
        const toolCalls = outputItems.filter((o) => o.type === "function_call");
        if (toolCalls.length === 0) {
          // Model responded without calling a tool — persist for terminal visibility
          window.electronAPI?.voice.persistTranscript?.({
            conversationId: this.conversationId ?? "voice-rtc",
            role: "assistant",
            text: "[NO TOOL CALL — model responded conversationally]",
          });
        }
        break;
      }

      case "error":
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Function call execution
  // ---------------------------------------------------------------------------

  /**
   * Call Mercury endpoint directly from the renderer using the same
   * auth/URL resolution as the voice session endpoint.
   * Then forward tool results to main process for Neri UI dispatch.
   */
  private async callMercury(message: string): Promise<string> {
    const { endpoint, headers } = await createServiceRequest("/api/mercury/chat");
    console.log("[Voice RTC] Mercury call:", message, "→", endpoint);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        conversationId: this.conversationId,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Mercury ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as {
      toolResults: Array<{
        action: string;
        spoken_summary?: string;
        query?: string;
        results?: Array<{ title: string; url: string; snippet: string }>;
        title?: string;
        html?: string;
        operation?: string;
        window_type?: string;
      }>;
      text: string | null;
    };

    // Log to terminal via persistTranscript
    const actions = data.toolResults.map((tr) => `${tr.action}(${tr.spoken_summary ?? ""})`).join(", ");
    window.electronAPI?.voice.persistTranscript?.({
      conversationId: this.conversationId ?? "voice-rtc",
      role: "assistant",
      text: `[MERCURY RESULTS: ${actions || "none"}]`,
    });

    // Dispatch Neri UI commands — store is in the same overlay renderer
    const api = window.electronAPI;
    for (const tr of data.toolResults) {
      switch (tr.action) {
        case "show_search":
          console.log("[Voice RTC] Calling showNeri for search");
          api?.overlay.showNeri?.();
          import("@/app/neri/neri-store").then(({ getNeriStore }) => {
            getNeriStore().dispatch({
              type: "open-search-window",
              query: tr.query ?? "",
              results: tr.results ?? [],
            });
          });
          break;
        case "open_dashboard":
          window.electronAPI?.voice.persistTranscript?.({
            conversationId: this.conversationId ?? "voice-rtc",
            role: "assistant",
            text: `[DISPATCH: showNeri, api exists=${!!api}, showNeri exists=${!!api?.overlay?.showNeri}]`,
          });
          api?.overlay.showNeri?.();
          break;
        case "close_dashboard":
          api?.overlay.hideNeri?.();
          break;
        case "create_canvas":
          api?.overlay.showNeri?.();
          import("@/app/neri/neri-store").then(({ getNeriStore }) => {
            getNeriStore().dispatch({
              type: "open-canvas-window",
              title: tr.title ?? "Canvas",
              html: tr.html ?? "",
            });
          });
          break;
        case "manage_windows":
          if (tr.operation === "close" && tr.window_type) {
            const windowType = tr.window_type;
            if (!isNeriWindowType(windowType)) {
              break;
            }
            import("@/app/neri/neri-store").then(({ getNeriStore }) => {
              getNeriStore().dispatch({
                type: "close-window-by-type",
                windowType,
              });
            });
          }
          break;
      }
    }

    // Return spoken summary for voice agent
    const spokenParts = data.toolResults
      .map((tr) => tr.spoken_summary)
      .filter(Boolean);
    return spokenParts.join(" ") || data.text || "";
  }

  /**
   * Fire Mercury in the background. The tool call already returned a quick
   * acknowledgment so the voice agent can speak immediately. When Mercury
   * completes, inject the real result into the conversation and trigger
   * a follow-up response.
   */
  private callMercuryAsync(message: string, _callId: string): void {
    this.callMercury(message)
      .then((spokenResult) => {
        if (!spokenResult || spokenResult === "Working on it.") return;
        // Inject Mercury's result as a new user-invisible context message
        // and trigger the model to speak the result
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[System: the action completed. Here is the result to share with the user: "${spokenResult}"]`,
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      })
      .catch((err) => {
        console.error("[realtime-voice] Mercury async error:", err);
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[System: the action failed with error: "${(err as Error).message}". Let the user know briefly.]`,
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      });
  }

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = item.name as string;
    console.log("[realtime-voice] handleFunctionCall called with tool:", name);
    // Forward to main process so it shows in terminal
    window.electronAPI?.voice.persistTranscript?.({
      conversationId: this.conversationId ?? "voice-rtc",
      role: "assistant",
      text: `[TOOL CALL: ${name}]`,
    });
    const callId = item.call_id as string;
    const argsStr = item.arguments as string;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr || "{}");
    } catch (err) {
      console.debug("[realtime-voice] Failed to parse tool arguments:", (err as Error).message);
      args = {};
    }

    this.emit({ type: "tool-start", name, callId });

    let result: string;
    try {
      if (name === "no_response") {
        // User is still thinking — stay silent. Send tool output but
        // do NOT trigger response.create so the model produces no speech.
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          },
        });
        this.emit({ type: "tool-end", name, callId, result: "ok" });
        return;
      } else if (name === "goodbye") {
        // The model already spoke its farewell before calling the tool.
        // Just send the tool output silently and disconnect.
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          },
        });
        this.emit({ type: "tool-end", name, callId, result: "ok" });

        // Brief delay so the farewell audio finishes playing
        setTimeout(() => {
          window.electronAPI?.ui.setState({ isVoiceRtcActive: false });
        }, 2000);
        return;
      } else if (name === "perform_action") {
        // Use the user's actual transcript instead of the model's paraphrase
        const message = this.lastUserTranscript || (args.message as string) || "";
        result = "Working on it.";
        this.callMercuryAsync(message, callId);
      } else {
        result = `Unknown tool: ${name}`;
      }
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }

    this.trace("TOOL_RESULT", `${name} → ${result.slice(0, 300)}`);
    this.emit({ type: "tool-end", name, callId, result });

    // Send function call output back to the Realtime API
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });

    // For async Mercury calls, don't request a response here — the
    // callMercuryAsync callback will inject the real result and trigger
    // response.create once Mercury completes. Requesting one now would
    // cause a premature "it should be open" before Mercury actually returns.
    if (name !== "perform_action") {
      this.sendEvent({ type: "response.create" });
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private cleanup() {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.inputTrack = null;

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        console.debug('[RealtimeVoice] Audio context close failed:', (err as Error).message);
      });
      this.audioContext = null;
      this.analyser = null;
    }

    if (this.outputAudioContext) {
      this.outputAudioContext.close().catch((err) => {
        console.debug('[RealtimeVoice] Output audio context close failed:', (err as Error).message);
      });
      this.outputAudioContext = null;
      this.outputAnalyser = null;
    }

    this.assistantTranscriptBuffer = "";
    this.stopPreConnectBuffering();
    this.preConnectBuffer = [];
    this.preConnectObservedSpeech = false;
    this.preConnectLastSpeechAt = 0;
    this.dataChannelOpenPromise = null;
    this.resolveDataChannelOpenPromise = null;
  }
}
