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
  | { type: "speaking-end" };

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
    console.log("[RealtimeVoice] token pre-fetched");
  } catch {
    // Silent — pre-fetch is best-effort
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
  console.log("[RealtimeVoice] using cached token");
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
  if (preWarmedSession) {
    if (preWarmConvId === conversationId) return;
    void preWarmedSession.disconnect();
    preWarmedSession = null;
    preWarmConvId = null;
  }
  const t0 = performance.now();
  console.log("[VoiceRTC:renderer] t+0ms pre-warm IPC received");
  const session = new RealtimeVoiceSession();
  preWarmedSession = session;
  preWarmConvId = conversationId;
  const token = consumeCachedToken() ?? undefined;
  console.log(`[VoiceRTC:renderer] t+${(performance.now() - t0).toFixed(0)}ms token=${token ? 'cached' : 'will-fetch'}, connecting...`);
  session.connect(conversationId, token).catch((err) => {
    console.error("[RealtimeVoice] pre-warm failed:", err);
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
  console.log("[RealtimeVoice] claimed pre-warmed session");
  return session;
}

// Register IPC listeners for main process triggers
if (typeof window !== "undefined") {
  const runtime = getVoiceRuntimeState();
  runtime.onPreWarm = (conversationId: string) => {
    preWarmVoiceSession(conversationId);
  };
  runtime.onPrefetch = () => {
    void prefetchToken();
  };

  const api = (window as { electronAPI?: {
    onVoiceRtcPreWarm?: (cb: (id: string) => void) => () => void;
    onVoiceRtcPrefetchToken?: (cb: () => void) => () => void;
  } }).electronAPI;

  if (api?.onVoiceRtcPreWarm && !runtime.preWarmUnsubscribe) {
    runtime.preWarmUnsubscribe = api.onVoiceRtcPreWarm((conversationId: string) => {
      runtime.onPreWarm?.(conversationId);
    });
  }

  if (api?.onVoiceRtcPrefetchToken && !runtime.prefetchUnsubscribe) {
    runtime.prefetchUnsubscribe = api.onVoiceRtcPrefetchToken(() => {
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
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private destroyed = false;

  // Pre-connection audio buffer — captures mic audio while SDP negotiation is in progress
  private preConnectBuffer: string[] = []; // base64-encoded PCM chunks
  private preConnectRecorder: ScriptProcessorNode | null = null;
  private preConnectCtx: AudioContext | null = null;
  private isBufferingPreConnect = false;

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;

  // Accumulated transcript fragments
  private assistantTranscriptBuffer = "";

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
    console.log(`[VoiceTrace] #${this.traceSeq} ${event}: ${detail}`);
  }

  /** Dump the full conversation trace to console for debugging. */
  dumpTrace() {
    console.log("\n[VoiceTrace] ═══ FULL CONVERSATION TRACE ═══");
    const startTime = this.traceLog[0]?.time ?? 0;
    for (const entry of this.traceLog) {
      const elapsed = ((entry.time - startTime) / 1000).toFixed(1).padStart(6);
      console.log(`  #${String(entry.seq).padStart(3)}  +${elapsed}s  [${entry.event}]  ${entry.detail}`);
    }
    console.log("[VoiceTrace] ═══ END TRACE ═══\n");
  }

  get state(): VoiceSessionState {
    return this._state;
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
        console.error("[RealtimeVoice] listener error:", err);
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
      await runtime.activeSession.disconnect().catch(() => {});
    }
    runtime.activeSession = this;

    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");
    const ct0 = performance.now();
    const ct = (label: string) => console.log(`[VoiceRTC:connect] +${(performance.now() - ct0).toFixed(0)}ms ${label}`);

    try {
      // ── Phase 1: Start ALL work in parallel ────────────────────────
      ct("phase1: starting parallel work");

      // A) Use pre-fetched token if available, otherwise fetch inline
      const keyPromise = prefetchedToken
        ? (ct("token: using prefetched"), Promise.resolve(prefetchedToken))
        : (async () => {
        ct("token: fetching inline...");
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
      ct("mic: requesting getUserMedia");
      const micPromise = navigator.mediaDevices.getUserMedia({
        audio: VOICE_MIC_CONSTRAINTS,
      }).then((stream) => {
        if (!this.destroyed) {
          ct("mic: acquired — starting pre-connect buffer");
          this.startPreConnectBuffering(stream);
        }
        return stream;
      });
      micPromise.catch(() => {});

      // C) Create RTCPeerConnection + SDP offer locally (no network, no mic needed)
      this.pc = new RTCPeerConnection(RTC_CONFIGURATION);
      const transceiver = this.pc.addTransceiver("audio", { direction: "sendrecv" });

      this.dc = this.pc.createDataChannel("oai-events");
      this.setupDataChannel();

      this.pc.ontrack = (event) => {
        if (this.destroyed) return;
        const remoteStream = event.streams[0];
        if (remoteStream) {
          ct("ontrack: remote audio stream received");
          this.setupAudioPlayback(remoteStream);
        }
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      ct("sdp: local offer created");
      if (this.destroyed) { this.cleanup(); return; }

      // ── Phase 2: SDP exchange — needs token, NOT mic ───────────────
      const keyResult = await keyPromise;
      ct("token: resolved");
      if (this.destroyed) { this.cleanup(); return; }

      const { clientSecret, model } = keyResult;

      ct("sdp: sending to OpenAI");
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
      ct("sdp: OpenAI responded");
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
      ct("sdp: remote description set");
      if (this.destroyed) { this.cleanup(); return; }

      // ── Phase 3: Attach mic track (likely already resolved) ────────
      const micStream = await micPromise;
      ct("mic: acquired");
      if (this.destroyed) {
        micStream.getTracks().forEach((t) => t.stop());
        this.cleanup();
        return;
      }
      this.localStream = micStream;
      await transceiver.sender.replaceTrack(micStream.getTracks()[0]);
      ct("mic: track attached to peer connection");

      // Setup audio analyser for visualization
      this.setupAudioAnalyser();

      ct("DONE — session connected");
      this.trace("CONNECTED", `conv=${conversationId} prefetched=${!!prefetchedToken}`);
      this.setState("connected");
    } catch (err) {
      if (this.destroyed) return;
      console.error("[RealtimeVoice] connect failed:", err);
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

  /** Get the audio analyser node for waveform visualization. */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  // ---------------------------------------------------------------------------
  // WebRTC internals
  // ---------------------------------------------------------------------------

  /** Start capturing mic audio into a buffer while we wait for the data channel. */
  private startPreConnectBuffering(micStream: MediaStream) {
    if (this.isBufferingPreConnect) return;
    this.isBufferingPreConnect = true;
    this.preConnectBuffer = [];

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
        // Convert to 16-bit PCM then base64 (matching OpenAI's input_audio_buffer.append format)
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
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
      console.log(`[VoiceRTC:connect] pre-connect buffering started`);
    } catch (err) {
      console.error("[VoiceRTC:connect] pre-connect buffering failed:", err);
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
      this.preConnectCtx.close().catch(() => {});
      this.preConnectCtx = null;
    }
  }

  /** Flush buffered pre-connect audio into the Realtime API via the data channel. */
  private flushPreConnectBuffer() {
    if (this.preConnectBuffer.length === 0) return;
    const chunks = this.preConnectBuffer;
    this.preConnectBuffer = [];
    console.log(`[VoiceRTC:connect] flushing ${chunks.length} pre-connect audio chunks`);
    for (const chunk of chunks) {
      this.sendEvent({
        type: "input_audio_buffer.append",
        audio: chunk,
      });
    }
  }

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {
      console.log("[RealtimeVoice] data channel open");
      // Flush any audio captured while waiting for the connection
      this.stopPreConnectBuffering();
      this.flushPreConnectBuffer();
    };

    this.dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleServerEvent(data);
      } catch (err) {
        console.error("[RealtimeVoice] failed to parse data channel message:", err);
      }
    };

    this.dc.onclose = () => {
      console.log("[RealtimeVoice] data channel closed");
      if (this._state === "connected") {
        this.cleanup();
        this.setState("error", "Connection lost");
      }
    };

    this.dc.onerror = (event) => {
      console.error("[RealtimeVoice] data channel error:", event);
    };
  }

  private setupAudioPlayback(stream: MediaStream) {
    if (this.destroyed) return;

    // Guard against duplicate ontrack — only set up playback once
    if (this.audioElement) return;

    this.audioElement = new Audio();
    this.audioElement.srcObject = stream;
    this.audioElement.autoplay = true;
    this.audioElement.play().catch((err) => {
      if (this.destroyed) return;
      console.error("[RealtimeVoice] audio play failed:", err);
    });
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
      console.error("[RealtimeVoice] analyser setup failed:", err);
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
          this.trace("TOOL_CALL", `${item.name}(${(item.arguments as string ?? "").slice(0, 200)})`);
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

      case "error": {
        const errorObj = event.error as { message?: string } | undefined;
        console.error("[RealtimeVoice] server error:", errorObj);
        break;
      }

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Function call execution — single orchestrator_chat tool
  // ---------------------------------------------------------------------------

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = item.name as string;
    const callId = item.call_id as string;
    const argsStr = item.arguments as string;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr || "{}");
    } catch {
      args = {};
    }

    this.emit({ type: "tool-start", name, callId });

    let result: string;
    try {
      if (name === "orchestrator_chat") {
        const message = (args.message as string) ?? "";
        const api = window.electronAPI;
        if (!api?.voiceOrchestratorChat) {
          result = "Error: Electron API not available";
        } else {
          result = await api.voiceOrchestratorChat({
            conversationId: this.conversationId ?? "voice-rtc",
            message,
          });
        }
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

    // Trigger model to continue (speak the result)
    this.sendEvent({ type: "response.create" });
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

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
      this.analyser = null;
    }

    this.assistantTranscriptBuffer = "";
    this.stopPreConnectBuffering();
    this.preConnectBuffer = [];
  }
}
