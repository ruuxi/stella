/**
 * RealtimeVoiceSession — WebRTC session manager for OpenAI Realtime API.
 *
 * Manages the full lifecycle of a voice-to-voice session:
 * - WebRTC peer connection + audio I/O
 * - Data channel for sending/receiving JSON events
 * - Single-tool delegation to the orchestrator via Electron IPC
 * - Conversation transcript logging
 */

import { postServiceJson } from "@/infra/http/service-request";
import { getVoiceSessionPromptConfig } from "@/prompts";
import {
  formatRealtimeSystemMessage,
  formatScreenLookFailedSystemReminder,
  formatVoiceActionCompletedSystemReminder,
  formatVoiceActionErrorSystemReminder,
  formatWebSearchFailedSystemReminder,
  formatWebSearchSystemReminder,
} from "../../../../../runtime/contracts/system-reminders.js";
import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";
import type { EventRecord } from "../../../../../runtime/contracts/local-chat.js";

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

type VoiceSessionToken = {
  provider?: "stella" | "openai";
  clientSecret: string;
  model: string;
  voice: string;
  expiresAt?: number;
  sessionId?: string;
};

type VoiceActionCompletedPayload = {
  conversationId: string;
  status: "completed" | "failed";
  message: string;
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

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const RTC_CONFIGURATION: RTCConfiguration = {
  // Pre-gather one ICE candidate batch to shorten negotiation time.
  iceCandidatePoolSize: 1,
};
const ECHO_GUARD_SAMPLE_MS = 40;
const ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD = 0.02;
const ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL = 0.05;
const ECHO_GUARD_BARGE_IN_MARGIN = 0.02;
const ECHO_GUARD_BARGE_IN_RATIO = 0.85;
const ECHO_GUARD_RELEASE_MS = 180;
const VOICE_CONTEXT_SYNC_EVENT_LIMIT = 80;

const VOICE_SYNC_IGNORED_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
]);
const VOICE_SYNC_ANNOUNCE_EVENT_TYPES = new Set([
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

type VoiceEchoMetrics = {
  assistantSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
  recentOutputActiveUntil?: number;
  now?: number;
};

/**
 * Lightweight goodbye matcher. We only fire on simple terminal
 * farewells — "bye", "goodbye", "bye stella", etc. — said as a
 * standalone utterance. Anything embedded in a longer sentence
 * ("…by Tuesday", "good morning") is left alone so the user can't
 * accidentally hang up mid-sentence.
 */
const GOODBYE_PHRASES = [
  /^(?:hey\s+|ok(?:ay)?\s+|alright\s+)?(?:bye|goodbye|good\s*bye)(?:\s+stella)?[\s.!?,]*$/i,
  /^(?:bye|goodbye)\s+(?:now|then|for\s+now)[\s.!?,]*$/i,
  /^(?:thanks?|thank\s+you)[,\s]+(?:bye|goodbye)[\s.!?,]*$/i,
];

function matchesGoodbye(transcript: string): boolean {
  const trimmed = transcript.trim();
  if (!trimmed) return false;
  return GOODBYE_PHRASES.some((re) => re.test(trimmed));
}

function shouldGateVoiceInputForEcho({
  assistantSpeaking,
  micLevel,
  outputLevel,
  recentOutputActiveUntil = 0,
  now = Date.now(),
}: VoiceEchoMetrics): boolean {
  const assistantAudioActive =
    assistantSpeaking || recentOutputActiveUntil > now;
  if (
    !assistantAudioActive ||
    outputLevel < ECHO_GUARD_OUTPUT_LEVEL_THRESHOLD
  ) {
    return false;
  }

  const userLikelyBargingIn =
    micLevel >= ECHO_GUARD_BARGE_IN_MIN_MIC_LEVEL &&
    micLevel >=
      outputLevel * ECHO_GUARD_BARGE_IN_RATIO + ECHO_GUARD_BARGE_IN_MARGIN;

  return !userLikelyBargingIn;
}

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

const buildVoiceSessionRequestBody = (
  conversationId?: string,
): Promise<{ conversationId?: string; instructions: string }> => {
  const convexConversationId = toConvexConversationId(conversationId);
  return Promise.resolve(window.electronAPI?.voice.getCoreMemory?.())
    .catch(() => null)
    .then((coreMemory) => {
      const instructions = buildVoiceSessionInstructions(coreMemory);
      return {
        ...(convexConversationId
          ? { conversationId: convexConversationId }
          : {}),
        instructions,
      };
    });
};

const buildVoiceSessionInstructions = (
  coreMemory: string | null | undefined,
): string => {
  const parts = [getVoiceSessionPromptConfig().basePrompt];
  const trimmedCoreMemory = coreMemory?.trim();
  if (trimmedCoreMemory) {
    parts.push(
      `<memory_file path="state/core-memory.md">\n${trimmedCoreMemory}\n</memory_file>`,
    );
  }
  return parts.join("\n\n");
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
  private inputEnergyBuffer: Uint8Array | null = null;
  private outputEnergyBuffer: Uint8Array | null = null;
  private unsubscribeActionCompleted: (() => void) | null = null;
  private unsubscribeLocalChatUpdated: (() => void) | null = null;
  private syncedLocalEventIds = new Set<string>();
  private localChatSyncPromise: Promise<void> = Promise.resolve();

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;
  private model: string | null = null;
  private sessionProvider: "stella" | "openai" = "stella";

  // Last finalized user transcript, used as fallback context for voice tools.
  private lastUserTranscript = "";

  constructor() {
    this.unsubscribeActionCompleted =
      window.electronAPI?.voice.onActionCompleted?.((payload) => {
        this.handleVoiceActionCompleted(payload);
      }) ?? null;
    this.unsubscribeLocalChatUpdated =
      window.electronAPI?.localChat.onUpdated?.(() => {
        void this.syncLocalChatContext();
      }) ?? null;
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
    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      // ── Phase 1: Start ALL work in parallel ────────────────────────

      // A) Create the ephemeral session token in parallel with local setup.
      const keyPromise = (async () => {
        const body = await buildVoiceSessionRequestBody(conversationId);
        const preferences = await window.electronAPI?.system
          ?.getLocalModelPreferences?.()
          .catch(() => null);
        if (preferences?.realtimeVoice?.provider === "openai") {
          const voiceApi = window.electronAPI?.voice;
          if (!voiceApi) {
            throw new Error("Voice API is not available.");
          }
          return await voiceApi.createOpenAISession({
            instructions: body.instructions,
          });
        }
        return postServiceJson<VoiceSessionToken>("/api/voice/session", body, {
          errorMessage: async (response) => {
            const detail = await response.text();
            return `Failed to create voice session: ${response.status} ${detail}`;
          },
        });
      })();

      // B) Create RTCPeerConnection + SDP offer locally (no network, no mic needed)
      this.pc = new RTCPeerConnection(RTC_CONFIGURATION);
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

      // ── Phase 2: SDP exchange — needs token, NOT mic ───────────────
      const keyResult = await keyPromise;
      if (this.destroyed) {
        this.cleanup();
        return;
      }

      const { clientSecret, model } = keyResult;
      this.model = model;
      this.sessionProvider = keyResult.provider ?? "stella";

      const sdpResponse = await fetch(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );
      if (this.destroyed) {
        this.cleanup();
        return;
      }

      if (!sdpResponse.ok) {
        throw new Error(
          `SDP negotiation failed: ${sdpResponse.status} ${await sdpResponse.text()}`,
        );
      }

      const answerSdp = await sdpResponse.text();
      await this.pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
      if (this.destroyed) {
        this.cleanup();
        return;
      }

      // ── Phase 3: Attach mic track (likely already resolved) ────────
      await this.syncInputState();

      getVoiceRuntimeState().activeSession = this;
      this.setState("connected");
      void this.syncLocalChatContext({ markExisting: true });
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

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {};

    this.dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleServerEvent(data);
      } catch (err) {
        console.debug(
          "[realtime-voice] Failed to parse data channel message:",
          (err as Error).message,
        );
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

    const preferredSpeakerId = localStorage.getItem(
      "stella-preferred-speaker-id",
    );
    if (
      preferredSpeakerId &&
      typeof this.audioElement.setSinkId === "function"
    ) {
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
    const buffer =
      kind === "input" ? this.inputEnergyBuffer : this.outputEnergyBuffer;
    const result = computeAnalyserEnergy(analyser, buffer);
    if (kind === "input") {
      this.inputEnergyBuffer = result.buffer;
    } else {
      this.outputEnergyBuffer = result.buffer;
    }
    return result.energy;
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

    const lease = await acquireSharedMicrophone();
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
      await this.sender.replaceTrack(
        this.processedInputTrack ?? this.inputTrack,
      );
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

  private syncLocalChatContext(options?: {
    markExisting?: boolean;
  }): Promise<void> {
    this.localChatSyncPromise = this.localChatSyncPromise
      .catch(() => undefined)
      .then(async () => {
        if (
          this.destroyed ||
          this._state !== "connected" ||
          !this.conversationId
        ) {
          return;
        }
        const api = window.electronAPI?.localChat;
        if (!api?.listEvents) {
          return;
        }

        const events = await api.listEvents({
          conversationId: this.conversationId,
          maxItems: VOICE_CONTEXT_SYNC_EVENT_LIMIT,
        });

        if (options?.markExisting) {
          for (const event of events) {
            this.syncedLocalEventIds.add(event._id);
          }
          return;
        }

        for (const event of events) {
          if (this.syncedLocalEventIds.has(event._id)) {
            continue;
          }
          this.syncedLocalEventIds.add(event._id);
          this.injectLocalChatEvent(event);
        }
      })
      .catch((err) => {
        console.debug(
          "[realtime-voice] Failed to sync local chat context:",
          (err as Error).message,
        );
      });

    return this.localChatSyncPromise;
  }

  private injectLocalChatEvent(event: EventRecord) {
    const mapped = this.mapLocalChatEventForVoice(event);
    if (!mapped) {
      return;
    }

    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: formatRealtimeSystemMessage(mapped.text),
          },
        ],
      },
    });
    if (mapped.announce) {
      this.sendEvent({ type: "response.create" });
    }
  }

  private mapLocalChatEventForVoice(
    event: EventRecord,
  ): { text: string; announce: boolean } | null {
    if (VOICE_SYNC_IGNORED_EVENT_TYPES.has(event.type)) {
      return null;
    }

    const payload = event.payload ?? {};
    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        return null;
      }
      if (payload.source === "voice") {
        return null;
      }
      const speaker =
        event.type === "user_message" ? "User" : "Text orchestrator";
      return {
        text: `${speaker} message in the synced chat context: ${text}`,
        announce: false,
      };
    }

    if (event.type === "agent-completed") {
      const result =
        typeof payload.result === "string" ? payload.result.trim() : "";
      return {
        text: `A delegated agent completed. ${result || "The delegated work is done."} Tell the user the result naturally if they have not already heard it.`,
        announce: true,
      };
    }

    if (event.type === "agent-failed" || event.type === "agent-canceled") {
      const error =
        typeof payload.error === "string" ? payload.error.trim() : "";
      const verb = event.type === "agent-failed" ? "failed" : "was canceled";
      return {
        text: `A delegated agent ${verb}. ${error || "No additional details were provided."} Tell the user briefly.`,
        announce: true,
      };
    }

    if (VOICE_SYNC_ANNOUNCE_EVENT_TYPES.has(event.type)) {
      return {
        text: `A delegated agent changed state: ${event.type}.`,
        announce: true,
      };
    }

    return null;
  }

  private async reportUsage(response: Record<string, unknown>) {
    const usage = response.usage as Record<string, unknown> | undefined;
    const responseId =
      typeof response.id === "string" && response.id.trim().length > 0
        ? response.id.trim()
        : null;
    const model = this.model;

    if (!usage || !responseId || !model || this.sessionProvider !== "stella") {
      return;
    }

    try {
      await postServiceJson<unknown>(
        "/api/voice/usage",
        {
          responseId,
          model,
          ...(this.conversationId
            ? { conversationId: this.conversationId }
            : {}),
          usage,
        },
        { parseResponse: false },
      );
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

  private handleVoiceActionCompleted(payload: VoiceActionCompletedPayload) {
    if (this.destroyed) return;
    if (!this.inputActive) {
      return;
    }
    if (
      !this.conversationId ||
      payload.conversationId !== this.conversationId
    ) {
      return;
    }

    const message = payload.message.trim();
    if (!message) {
      return;
    }

    const statusText =
      payload.status === "completed"
        ? "The delegated action is complete."
        : "The delegated action failed.";
    window.electronAPI?.voice.persistTranscript?.({
      conversationId: this.conversationId,
      role: "assistant",
      text: `[VOICE ACTION ${payload.status.toUpperCase()}] ${message}`,
      uiVisibility: "hidden",
    });
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: formatVoiceActionCompletedSystemReminder(statusText, message),
          },
        ],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  // ---------------------------------------------------------------------------
  // Server event handling
  // ---------------------------------------------------------------------------

  private handleServerEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    switch (type) {
      case "session.created":
        break;
      case "session.updated":
        break;

      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          void this.handleFunctionCall(item);
        }
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = (event as { delta?: string }).delta;
        if (delta) {
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
          this.emit({
            type: "assistant-transcript",
            text: transcript,
            isFinal: true,
          });
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
          this.lastUserTranscript = transcript;
          this.emit({
            type: "user-transcript",
            text: transcript,
            isFinal: true,
          });
          if (matchesGoodbye(transcript)) {
            // The user said "bye" — exit voice mode. We DON'T disconnect
            // the WebRTC session here: with wake-word pre-warm we want
            // the connection to stay open with the mic gated off. We
            // ask main to toggle voice mode off (same path the
            // keybind / radial wedge uses); main flips
            // `isVoiceRtcActive=false`, which propagates back to
            // `VoiceSessionManager.updateSession` and silences the mic
            // while keeping the pre-warmed session alive for the next
            // "Hey Stella". Routed via the pet's `requestVoice` IPC
            // because that's a privileged-sender channel and toggles
            // the same `togglePetVoice` source of truth used
            // elsewhere.
            queueMicrotask(() => {
              try {
                window.electronAPI?.pet?.requestVoice?.();
              } catch (err) {
                console.debug(
                  "[realtime-voice] goodbye toggle failed:",
                  (err as Error).message,
                );
              }
            });
          }
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
        this.assistantOutputActive = true;
        this.recentOutputActiveUntil = Date.now() + ECHO_GUARD_RELEASE_MS;
        this.startEchoGuardMonitor();
        this.syncEchoGuard();
        this.emit({ type: "speaking-start" });
        break;

      case "output_audio.done":
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
   * Delegate a voice action to the orchestrator in the background.
   * Completion is no longer inferred from the orchestrator turn ending; the
   * orchestrator must call voice_result with the terminal result.
   */
  private runPerformActionAsync(message: string): void {
    const api = window.electronAPI?.voice;
    if (!api?.orchestratorChat || !this.conversationId) {
      console.warn(
        "[realtime-voice] Cannot delegate to orchestrator: missing IPC or conversation ID",
      );
      return;
    }

    api
      .orchestratorChat({
        conversationId: this.conversationId,
        message,
      })
      .then((reply) => {
        const spokenResult = reply.trim();
        window.electronAPI?.voice.persistTranscript?.({
          conversationId: this.conversationId ?? "voice-rtc",
          role: "assistant",
          text: `[ORCHESTRATOR TURN ENDED] ${spokenResult || "(empty)"}`,
          uiVisibility: "hidden",
        });
      })
      .catch((err) => {
        console.error("[realtime-voice] Orchestrator delegation error:", err);
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: formatVoiceActionErrorSystemReminder(
                  (err as Error).message,
                ),
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      });
  }

  private runWebSearchAsync(query: string, category?: string): void {
    const api = window.electronAPI?.voice;
    if (!api?.webSearch) {
      console.warn("[realtime-voice] Cannot run web search: missing IPC");
      return;
    }

    api
      .webSearch({
        query,
        category,
      })
      .then((result) => {
        window.electronAPI?.voice.persistTranscript?.({
          conversationId: this.conversationId ?? "voice-rtc",
          role: "assistant",
          text: `[WEB SEARCH] ${query} → ${result.results.length} results`,
          uiVisibility: "hidden",
        });

        let resultText: string;
        if (result.results.length === 0) {
          resultText = `Web search for "${query}" returned no results.`;
        } else {
          const summary = result.results
            .slice(0, 5)
            .map((r) => `${r.title}: ${r.snippet}`)
            .join("\n\n");
          resultText = `Web search results for "${query}":\n\n${summary}`;
        }

        // Inject results into the conversation so the model knows the search finished
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: formatWebSearchSystemReminder(resultText),
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      })
      .catch((err) => {
        console.error("[realtime-voice] Web search error:", err);
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: formatWebSearchFailedSystemReminder(
                  (err as Error).message,
                ),
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      });
  }

  private runLookAtScreenAsync(query: string): void {
    const captureApi = window.electronAPI?.capture;
    if (!captureApi?.visionScreenshots) {
      console.warn("[realtime-voice] Cannot look at screen: missing IPC");
      return;
    }

    (async () => {
      try {
        const screenshots = await captureApi.visionScreenshots();
        if (!Array.isArray(screenshots) || screenshots.length === 0) {
          throw new Error("Screen capture returned no images");
        }

        const content: Array<
          | { type: "input_text"; text: string }
          | {
              type: "input_image";
              image_url: string;
              detail?: "auto" | "low" | "high";
            }
        > = [
          {
            type: "input_text",
            text:
              `The user asked: "${query || this.lastUserTranscript || "Look at my screen."}"\n` +
              "Use the attached screenshot(s) to answer naturally and conversationally. " +
              "If the user is asking where something is or what to click, describe its location clearly in words.",
          },
        ];

        for (const screenshot of screenshots.slice(0, 3)) {
          const coordinateSpace = screenshot.coordinateSpace;
          content.push({
            type: "input_text",
            text:
              `${screenshot.label}. ` +
              `Image dimensions: ${coordinateSpace.targetWidth}x${coordinateSpace.targetHeight} pixels. ` +
              `Use screen ${screenshot.screenNumber} for this image.`,
          });
          content.push({
            type: "input_image",
            image_url: screenshot.dataUrl,
            detail: "auto",
          });
        }

        window.electronAPI?.voice.persistTranscript?.({
          conversationId: this.conversationId ?? "voice-rtc",
          role: "assistant",
          text: `[SCREEN LOOK] ${query || this.lastUserTranscript || "(no query)"} → ${screenshots.length} screenshots`,
          uiVisibility: "hidden",
        });

        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content,
          },
        });
        this.sendEvent({ type: "response.create" });
      } catch (err) {
        console.error("[realtime-voice] Screen guide error:", err);
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: formatScreenLookFailedSystemReminder(
                  (err as Error).message,
                ),
              },
            ],
          },
        });
        this.sendEvent({ type: "response.create" });
      }
    })();
  }

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = item.name as string;
    console.log("[realtime-voice] handleFunctionCall called with tool:", name);
    // Forward to main process so it shows in terminal
    window.electronAPI?.voice.persistTranscript?.({
      conversationId: this.conversationId ?? "voice-rtc",
      role: "assistant",
      text: `[TOOL CALL: ${name}]`,
      uiVisibility: "hidden",
    });
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
      } else if (name === "goodbye" || name === "close") {
        // The model already spoke its farewell before calling the tool.
        // Stop live RTC input now, but keep the warm session/output alive.
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
      } else if (name === "web_search") {
        const query = (args.query as string) || this.lastUserTranscript || "";
        result = "Searching now.";
        this.runWebSearchAsync(query, args.category as string | undefined);
      } else if (name === "look_at_screen") {
        const query = (args.query as string) || this.lastUserTranscript || "";
        result = "Let me take a look.";
        this.runLookAtScreenAsync(query);
      } else if (name === "perform_action") {
        if (!this.inputActive) {
          result =
            "Voice mode is no longer active. Do not call tools or continue this voice-only action.";
          this.emit({ type: "tool-end", name, callId, result });
          this.sendEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: result,
            },
          });
          return;
        }
        // Delegate to orchestrator. Use the user's actual transcript
        // instead of the model's paraphrase for better fidelity.
        const message =
          this.lastUserTranscript || (args.message as string) || "";
        result =
          "Stella is working on this now. Do not say it is complete yet. You will receive a message later when the work is genuinely done or has failed.";
        this.runPerformActionAsync(message);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }

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

    // For async calls, don't request a response here — the async handler
    // will inject the real result and trigger response.create.
    if (
      name !== "perform_action" &&
      name !== "web_search" &&
      name !== "look_at_screen"
    ) {
      this.sendEvent({ type: "response.create" });
    }
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
    this.unsubscribeActionCompleted?.();
    this.unsubscribeActionCompleted = null;
    this.unsubscribeLocalChatUpdated?.();
    this.unsubscribeLocalChatUpdated = null;
    this.syncedLocalEventIds.clear();

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

    this.model = null;
    this.sessionProvider = "stella";
    this.inputEnergyBuffer = null;
    this.outputEnergyBuffer = null;
  }
}
