/**
 * RealtimeVoiceSession — WebRTC session manager for Inworld Realtime API.
 *
 * Manages the full lifecycle of a voice-to-voice session:
 * - WebRTC peer connection + audio I/O
 * - Data channel for sending/receiving JSON events
 * - Single-tool delegation to the orchestrator via Electron IPC
 * - Conversation transcript logging
 */

import { createServiceRequest } from "@/infra/http/service-request";
import {
  getVoiceSessionPromptConfig,
} from "@/prompts";
import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";

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

type VoiceSessionResult = {
  sdpAnswer: string;
  model: string;
  voice: string;
  callId?: string;
  sessionConfig?: Record<string, unknown>;
};

type VoiceRuntimeState = {
  activeSession: { disconnect: () => Promise<void> } | null;
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

/** Strip reasoning model `<think>…</think>` blocks from text. */
const stripThinkTags = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const RTC_CONFIGURATION: RTCConfiguration = {
  iceCandidatePoolSize: 1,
};
const RTC_VOICE_MIC_USE_CASE = "voice-rtc" as const;
const ECHO_GUARD_SAMPLE_MS = 40;
const ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD = 0.02;
const ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL = 0.05;
const ECHO_GUARD_BARGE_IN_MARGIN = 0.02;
const ECHO_GUARD_BARGE_IN_RATIO = 0.85;
const ECHO_GUARD_RELEASE_MS = 180;

type VoiceEchoMetrics = {
  assistantSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
  recentOutputActiveUntil?: number;
  now?: number;
};

export function shouldGateVoiceInputForEcho({
  assistantSpeaking,
  micLevel,
  outputLevel,
  recentOutputActiveUntil = 0,
  now = Date.now(),
}: VoiceEchoMetrics): boolean {
  const assistantAudioActive =
    assistantSpeaking || recentOutputActiveUntil > now;
  if (!assistantAudioActive || outputLevel < ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD) {
    return false;
  }

  const userLikelyBargingIn =
    micLevel >= ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL &&
    micLevel >= outputLevel * ECHO_GUARD_BARGE_IN_RATIO + ECHO_GUARD_BARGE_IN_MARGIN;

  return !userLikelyBargingIn;
}

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

const buildVoiceSessionRequestBody = (
  sdpOffer: string,
  conversationId?: string,
) => {
  const convexConversationId = toConvexConversationId(conversationId);
  return {
    sdpOffer,
    ...(convexConversationId ? { conversationId: convexConversationId } : {}),
    ...getVoiceSessionPromptConfig(),
  };
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sender: RTCRtpSender | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private micLease: SharedMicrophoneLease | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private inputSourceNode: MediaStreamAudioSourceNode | null = null;
  private inputGateNode: GainNode | null = null;
  private inputDestination: MediaStreamAudioDestinationNode | null = null;
  private processedInputTrack: MediaStreamTrack | null = null;
  private outputMonitorSource: MediaStreamAudioSourceNode | null = null;
  private pendingRemoteStream: MediaStream | null = null;
  private destroyed = false;
  private inputActive = false;
  private inputSyncPromise: Promise<void> = Promise.resolve();
  private assistantOutputActive = false;
  private recentOutputActiveUntil = 0;
  private softInputMuted = false;
  private echoGuardTimer: ReturnType<typeof setInterval> | null = null;
  private inputEnergyBuffer: Uint8Array<ArrayBuffer> | null = null;
  private outputEnergyBuffer: Uint8Array<ArrayBuffer> | null = null;

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;
  private model: string | null = null;
  private pendingSessionConfig: Record<string, unknown> | null = null;

  // Accumulated transcript fragments
  private assistantTranscriptBuffer = "";
  // Conversation trace log — sequential record of every event for debugging
  private static readonly MAX_TRACE_ENTRIES = 500;
  private traceLog: Array<{
    seq: number;
    time: number;
    event: string;
    detail: string;
  }> = [];
  private traceSeq = 0;

  private trace(event: string, detail: string) {
    this.traceSeq++;
    if (this.traceLog.length >= RealtimeVoiceSession.MAX_TRACE_ENTRIES) {
      this.traceLog.shift();
    }
    this.traceLog.push({ seq: this.traceSeq, time: Date.now(), event, detail });
  }

  /** Return the full conversation trace for debugging. */
  dumpTrace(): Array<{
    seq: number;
    time: number;
    event: string;
    detail: string;
  }> {
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
   * Session stays connected; microphone capture is suspended while inactive.
   */
  setInputActive(active: boolean) {
    this.inputActive = active;
    void this.syncInputState().catch((err) => {
      console.debug(
        "[realtime-voice] Failed to sync microphone state:",
        (err as Error).message,
      );
    });
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
        console.debug(
          "[realtime-voice] Listener error:",
          (err as Error).message,
        );
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

  async connect(conversationId: string): Promise<void> {
    this.trace("CONNECT", `state=${this._state}`);
    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      // ── Phase 1: Fetch ICE servers for NAT traversal ──────────────
      const { endpoint: iceEndpoint, headers: iceHeaders } =
        await createServiceRequest("/api/voice/ice-servers");
      const iceRes = await fetch(iceEndpoint, { headers: iceHeaders });
      const iceData = iceRes.ok
        ? (await iceRes.json()) as { ice_servers?: RTCIceServer[] }
        : null;
      if (this.destroyed) { this.cleanup(); return; }

      // ── Phase 2: Create RTCPeerConnection + SDP offer ─────────────
      const rtcConfig: RTCConfiguration = {
        ...RTC_CONFIGURATION,
        ...(iceData?.ice_servers?.length ? { iceServers: iceData.ice_servers } : {}),
      };
      this.pc = new RTCPeerConnection(rtcConfig);
      this.pc.oniceconnectionstatechange = () => {
        this.trace("ICE", this.pc?.iceConnectionState ?? "unknown");
      };
      this.pc.onconnectionstatechange = () => {
        this.trace("PC", this.pc?.connectionState ?? "unknown");
      };
      const transceiver = this.pc.addTransceiver("audio", {
        direction: "sendrecv",
      });
      this.sender = transceiver.sender;

      this.dc = this.pc.createDataChannel("oai-events");
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
      if (this.destroyed) {
        this.cleanup();
        return;
      }

      // ── Phase 3: Proxy SDP exchange through backend ────────────────
      const { endpoint, headers } =
        await createServiceRequest("/api/voice/session");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(
          buildVoiceSessionRequestBody(offer.sdp!, conversationId),
        ),
      });
      if (this.destroyed) {
        this.cleanup();
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(
          `Failed to create voice session: ${res.status} ${detail}`,
        );
      }

      const sessionResult = (await res.json()) as VoiceSessionResult;
      this.model = sessionResult.model;
      this.pendingSessionConfig = sessionResult.sessionConfig ?? null;

      await this.pc.setRemoteDescription({
        type: "answer",
        sdp: sessionResult.sdpAnswer,
      });
      if (this.destroyed) {
        this.cleanup();
        return;
      }

      // ── Phase 3: Attach mic track ─────────────────────────────────
      await this.syncInputState();

      getVoiceRuntimeState().activeSession = this;
      this.trace("CONNECTED", `conv=${conversationId}`);
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

  injectWakeWordPrefill(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    this.trace("WAKE_WORD_PREFILL", trimmed);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: trimmed,
          },
        ],
      },
    });
  }

  // ---------------------------------------------------------------------------
  // WebRTC internals
  // ---------------------------------------------------------------------------

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {
      this.trace("DC", "opened");
      if (this.pendingSessionConfig) {
        const msg = JSON.stringify({
          type: "session.update",
          session: this.pendingSessionConfig,
        });
        this.trace("DC", `session.update sent (${msg.length} bytes)`);
        this.dc!.send(msg);
        this.pendingSessionConfig = null;
      } else {
        console.warn("[voice] DC opened but no pendingSessionConfig");
      }
    };

    this.dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.trace("DC_EVENT", data.type as string);
        this.handleServerEvent(data);
      } catch (err) {
        console.debug(
          "[realtime-voice] Failed to parse data channel message:",
          (err as Error).message,
        );
      }
    };

    this.dc.onclose = () => {
      this.trace("DC", "closed");
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

    const preferredSpeakerId = localStorage.getItem("stella-preferred-speaker-id");
    if (preferredSpeakerId && typeof this.audioElement.setSinkId === "function") {
      this.audioElement.setSinkId(preferredSpeakerId).catch((err) => {
        console.debug(
          "[RealtimeVoice] setSinkId failed, using default output:",
          (err as Error).message,
        );
      });
    }

    this.audioElement.play().catch((err) => {
      console.debug(
        "[RealtimeVoice] Audio playback failed:",
        (err as Error).message,
      );
    });

    // Create analyser for the output (assistant) audio stream.
    // Don't connect to destination — the Audio element handles playback.
    try {
      this.pendingRemoteStream = stream;
      this.attachOutputMonitor(stream);
    } catch (err) {
      console.debug(
        "[realtime-voice] Output analyser setup failed:",
        (err as Error).message,
      );
    }
  }

  private setupLocalAudioPipeline(stream: MediaStream) {
    try {
      if (!this.audioContext) {
        const ctx = new AudioContext();
        this.audioContext = ctx;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.inputGateNode = ctx.createGain();
        this.inputGateNode.gain.value = 1;
        this.inputDestination = ctx.createMediaStreamDestination();
        this.inputGateNode.connect(this.inputDestination);
        this.processedInputTrack =
          this.inputDestination.stream.getAudioTracks()[0] ?? null;

        if (this.pendingRemoteStream) {
          this.attachOutputMonitor(this.pendingRemoteStream);
        }
      }

      this.attachLocalInputStream(stream);
    } catch (err) {
      console.debug(
        "[realtime-voice] Analyser setup failed:",
        (err as Error).message,
      );
    }
  }

  private attachLocalInputStream(stream: MediaStream) {
    if (!this.audioContext || !this.analyser || !this.inputGateNode) {
      return;
    }

    if (this.inputSourceNode) {
      this.inputSourceNode.disconnect();
      this.inputSourceNode = null;
    }

    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.analyser);
    source.connect(this.inputGateNode);
    this.inputSourceNode = source;
  }

  private getAnalyserEnergy(
    analyser: AnalyserNode | null,
    kind: "input" | "output",
  ): number {
    if (!analyser) {
      return 0;
    }

    const len = analyser.frequencyBinCount;
    const buffer =
      kind === "input" ? this.inputEnergyBuffer : this.outputEnergyBuffer;
    if (!buffer || buffer.length < len) {
      const nextBuffer = new Uint8Array(len);
      if (kind === "input") {
        this.inputEnergyBuffer = nextBuffer;
      } else {
        this.outputEnergyBuffer = nextBuffer;
      }
    }

    const targetBuffer =
      (kind === "input" ? this.inputEnergyBuffer : this.outputEnergyBuffer)
      ?? new Uint8Array(len);
    analyser.getByteFrequencyData(targetBuffer);

    let sum = 0;
    for (let i = 0; i < len; i += 1) {
      const value = targetBuffer[i] / 255;
      sum += value * value;
    }

    return Math.sqrt(sum / Math.max(1, len));
  }

  private startEchoGuardMonitor() {
    if (this.echoGuardTimer) {
      return;
    }

    this.echoGuardTimer = setInterval(() => {
      this.syncEchoGuard();
      if (
        !this.inputActive &&
        !this.assistantOutputActive &&
        this.recentOutputActiveUntil <= Date.now()
      ) {
        this.stopEchoGuardMonitor();
      }
    }, ECHO_GUARD_SAMPLE_MS);
  }

  private stopEchoGuardMonitor() {
    if (this.echoGuardTimer) {
      clearInterval(this.echoGuardTimer);
      this.echoGuardTimer = null;
    }
  }

  private applySoftInputMute(shouldMute: boolean) {
    this.softInputMuted = shouldMute;

    if (!this.inputGateNode || !this.audioContext) {
      return;
    }

    const targetValue = shouldMute ? 0 : 1;
    const now = this.audioContext.currentTime;
    this.inputGateNode.gain.cancelScheduledValues(now);
    this.inputGateNode.gain.setTargetAtTime(targetValue, now, 0.015);
  }

  private syncEchoGuard() {
    const shouldMute =
      this.inputActive &&
      shouldGateVoiceInputForEcho({
        assistantSpeaking: this.assistantOutputActive,
        micLevel: this.getAnalyserEnergy(this.analyser, "input"),
        outputLevel: this.getAnalyserEnergy(this.outputAnalyser, "output"),
        recentOutputActiveUntil: this.recentOutputActiveUntil,
      });

    if (this.softInputMuted !== shouldMute) {
      this.applySoftInputMute(shouldMute);
    }
  }

  private syncInputState(): Promise<void> {
    this.inputSyncPromise = this.inputSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (this.destroyed) {
          return;
        }

        if (this.inputActive) {
          await this.resumeMicrophoneCapture();
          if (!this.inputActive || this.destroyed) {
            await this.suspendMicrophoneCapture();
          }
          return;
        }

        await this.suspendMicrophoneCapture();
      });

    return this.inputSyncPromise;
  }

  private async suspendMicrophoneCapture() {
    if (!this.inputTrack && !this.localStream && !this.micLease) {
      this.applySoftInputMute(false);
      return;
    }

    const sender = this.sender;
    if (sender) {
      try {
        await sender.replaceTrack(null);
      } catch (err) {
        console.debug(
          "[RealtimeVoice] Failed to detach microphone track:",
          (err as Error).message,
        );
      }
    }

    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = false;
    }

    this.applySoftInputMute(false);
    this.releaseLocalMicrophoneCapture();
  }

  private async resumeMicrophoneCapture() {
    if (!this.inputActive || this.destroyed) {
      return;
    }

    if (!this.sender) {
      return;
    }

    if (this.inputTrack && this.inputTrack.readyState === "live") {
      this.inputTrack.enabled = true;
      this.startEchoGuardMonitor();
      this.syncEchoGuard();
      return;
    }

    const lease = await acquireSharedMicrophone({
      useCase: RTC_VOICE_MIC_USE_CASE,
    });
    if (!this.inputActive || this.destroyed) {
      lease.release();
      return;
    }

    this.micLease = lease;
    this.localStream = lease.stream;
    this.inputTrack = this.localStream.getTracks()[0] ?? null;

    if (!this.inputTrack) {
      this.micLease.release();
      this.micLease = null;
      this.localStream = null;
      throw new Error("No microphone track available");
    }

    this.setupLocalAudioPipeline(this.localStream);
    this.inputTrack.enabled = true;
    this.startEchoGuardMonitor();
    this.syncEchoGuard();

    try {
      await this.sender.replaceTrack(this.processedInputTrack ?? this.inputTrack);
    } catch (err) {
      this.releaseLocalMicrophoneCapture();
      throw err;
    }
  }

  private releaseLocalMicrophoneCapture() {
    if (this.inputSourceNode) {
      this.inputSourceNode.disconnect();
      this.inputSourceNode = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.micLease) {
      this.micLease.release();
      this.micLease = null;
    }

    this.inputTrack = null;
  }

  private attachOutputMonitor(stream: MediaStream) {
    if (!this.audioContext) return;

    this.pendingRemoteStream = stream;

    if (this.outputMonitorSource) {
      this.outputMonitorSource.disconnect();
      this.outputMonitorSource = null;
    }

    this.outputAnalyser = this.audioContext.createAnalyser();
    this.outputAnalyser.fftSize = 256;
    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.outputAnalyser);
    this.outputMonitorSource = source;
    this.startEchoGuardMonitor();
    this.syncEchoGuard();
  }

  private sendEvent(event: Record<string, unknown>) {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(event));
    }
  }

  private async reportUsage(response: Record<string, unknown>) {
    const usage = response.usage as Record<string, unknown> | undefined;
    const responseId =
      typeof response.id === "string" && response.id.trim().length > 0
        ? response.id.trim()
        : null;
    const model = this.model;

    if (!usage || !responseId || !model) {
      return;
    }

    try {
      const { endpoint, headers } = await createServiceRequest("/api/voice/usage");
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          responseId,
          model,
          ...(this.conversationId ? { conversationId: this.conversationId } : {}),
          usage,
        }),
      });
    } catch (err) {
      console.debug(
        "[realtime-voice] Failed to report voice usage:",
        (err as Error).message,
      );
    }
  }

  private closeRealtimeVoiceInput() {
    // Goodbye ends the live turn immediately, but the warm RTC session stays
    // connected so any already-started assistant audio can finish naturally.
    this.setInputActive(false);
    window.electronAPI?.ui.setState({ isVoiceRtcActive: false });
  }

  // ---------------------------------------------------------------------------
  // Server event handling
  // ---------------------------------------------------------------------------

  private handleServerEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    switch (type) {
      case "session.created":
        console.warn("[voice] session.created received");
        this.trace("SESSION", "created");
        break;
      case "session.updated":
        console.warn("[voice] session.updated received");
        this.trace("SESSION", "updated");
        break;
      case "error":
        console.warn("[voice] ERROR from server:", JSON.stringify(event.error ?? event));
        break;

      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          this.trace(
            "TOOL_CALL",
            `${item.name}(${String(item.arguments ?? "").slice(0, 200)})`,
          );
          void this.handleFunctionCall(item);
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
          this.assistantTranscriptBuffer += delta;
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const raw = (event as { transcript?: string }).transcript;
        const transcript = raw ? stripThinkTags(raw).trim() : "";
        if (transcript) {
          this.trace("ASSISTANT_MSG", transcript);
          this.emit({
            type: "assistant-transcript",
            text: transcript,
            isFinal: true,
          });
        }
        this.assistantTranscriptBuffer = "";
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
      case "output_audio_buffer.started":
        this.assistantOutputActive = true;
        this.recentOutputActiveUntil = Date.now() + ECHO_GUARD_RELEASE_MS;
        this.startEchoGuardMonitor();
        this.syncEchoGuard();
        this.emit({ type: "speaking-start" });
        break;

      case "output_audio.done":
      case "output_audio_buffer.stopped":
        this.assistantOutputActive = false;
        this.recentOutputActiveUntil = Date.now() + ECHO_GUARD_RELEASE_MS;
        this.startEchoGuardMonitor();
        this.syncEchoGuard();
        this.emit({ type: "speaking-end" });
        break;

      case "input_audio_buffer.speech_started":
        this.emit({ type: "user-speaking-start" });
        break;

      case "input_audio_buffer.speech_stopped":
        this.emit({ type: "user-speaking-end" });
        break;

      case "response.done": {
        const output = (event as Record<string, unknown>).response as
          | Record<string, unknown>
          | undefined;
        if (output) {
          void this.reportUsage(output);
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
   * Execute a tool via the generic IPC bridge. The tool call already returned
   * an immediate acknowledgment so the voice model can keep speaking. When the
   * tool result arrives, inject it into the conversation and trigger a
   * follow-up response so the model speaks the result.
   */
  private runToolAsync(
    toolName: string,
    toolArgs: Record<string, unknown>,
    callId: string,
  ): void {
    const api = window.electronAPI?.voice;
    if (!api?.executeTool || !this.conversationId) {
      console.warn(
        "[realtime-voice] Cannot execute tool: missing IPC or conversation ID",
      );
      return;
    }

    api
      .executeTool({
        toolName,
        toolArgs,
        conversationId: this.conversationId,
        callId,
      })
      .then((response) => {
        const resultText = response.error
          ? `Tool "${toolName}" failed: ${response.error}`
          : (response.result || "Done.");

        if (!response.error && resultText === "Done.") return;

        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: response.error
                  ? `[System: ${resultText}. Let the user know briefly.]`
                  : `[System: Tool "${toolName}" completed. Result: ${resultText}]\n\nShare this with the user conversationally. Be concise.`,
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      })
      .catch((err) => {
        console.error(`[realtime-voice] Tool ${toolName} error:`, err);
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[System: Tool "${toolName}" failed: ${(err as Error).message}. Let the user know briefly.]`,
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      });
  }

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = item.name as string;
    console.debug("[realtime-voice] handleFunctionCall:", name);
    const callId = item.call_id as string;
    const argsStr = item.arguments as string;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr || "{}");
    } catch (err) {
      console.debug(
        "[realtime-voice] Failed to parse tool arguments:",
        (err as Error).message,
      );
      args = {};
    }

    this.emit({ type: "tool-start", name, callId });

    // ── Silent tools (no speech generated) ──────────────────────────────
    if (name === "no_response") {
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
    }

    if (name === "goodbye" || name === "close") {
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: "ok",
        },
      });
      this.emit({ type: "tool-end", name, callId, result: "ok" });
      this.closeRealtimeVoiceInput();
      return;
    }

    // ── All other tools: execute via generic IPC bridge ──────────────────
    const ack = "Processing...";
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: ack,
      },
    });
    this.trace("TOOL_RESULT", `${name} → ${ack}`);
    this.emit({ type: "tool-end", name, callId, result: ack });

    this.runToolAsync(name, args, callId);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private cleanup() {
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;

    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    this.releaseLocalMicrophoneCapture();
    this.sender = null;

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        console.debug(
          "[RealtimeVoice] Audio context close failed:",
          (err as Error).message,
        );
      });
      this.audioContext = null;
      this.analyser = null;
      this.inputGateNode = null;
      this.inputDestination = null;
      this.processedInputTrack = null;
    }
    this.outputAnalyser = null;
    if (this.outputMonitorSource) {
      this.outputMonitorSource.disconnect();
    }
    this.outputMonitorSource = null;
    this.pendingRemoteStream = null;

    this.assistantTranscriptBuffer = "";
    this.model = null;
    this.inputEnergyBuffer = null;
    this.outputEnergyBuffer = null;
  }
}
