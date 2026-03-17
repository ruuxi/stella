/**
 * RealtimeVoiceSession — WebRTC session manager for OpenAI Realtime API.
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

type VoiceSessionToken = {
  clientSecret: string;
  model: string;
  voice: string;
  expiresAt?: number;
  sessionId?: string;
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
const RTC_VOICE_MIC_USE_CASE = "voice-rtc" as const;

const toConvexConversationId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized;
};

const buildVoiceSessionRequestBody = (
  conversationId?: string,
): { conversationId?: string; basePrompt: string } => {
  const convexConversationId = toConvexConversationId(conversationId);
  return {
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
  private outputMonitorSource: MediaStreamAudioSourceNode | null = null;
  private pendingRemoteStream: MediaStream | null = null;
  private destroyed = false;
  private inputActive = false;
  private inputSyncPromise: Promise<void> = Promise.resolve();

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;
  private model: string | null = null;

  // Accumulated transcript fragments
  private assistantTranscriptBuffer = "";
  private lastUserTranscript = "";

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
    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      // ── Phase 1: Start ALL work in parallel ────────────────────────

      // A) Create the ephemeral session token in parallel with local setup.
      const keyPromise = (async () => {
        const { endpoint, headers } =
          await createServiceRequest("/api/voice/session");
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(buildVoiceSessionRequestBody(conversationId)),
        });
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(
            `Failed to create voice session: ${res.status} ${detail}`,
          );
        }
        return (await res.json()) as VoiceSessionToken;
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

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
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
    if (!this.audioContext || !this.analyser) {
      return;
    }

    if (this.inputSourceNode) {
      this.inputSourceNode.disconnect();
      this.inputSourceNode = null;
    }

    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(this.analyser);
    this.inputSourceNode = source;
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

    try {
      await this.sender.replaceTrack(this.inputTrack);
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
        this.trace("SESSION", "created");
        break;
      case "session.updated":
        this.trace("SESSION", "updated");
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
        const output = (event as Record<string, unknown>).response as
          | Record<string, unknown>
          | undefined;
        const outputItems =
          (output?.output as Array<Record<string, unknown>>) ?? [];
        const toolCalls = outputItems.filter((o) => o.type === "function_call");
        if (toolCalls.length === 0) {
          // Model responded without calling a tool — persist for terminal visibility
          window.electronAPI?.voice.persistTranscript?.({
            conversationId: this.conversationId ?? "voice-rtc",
            role: "assistant",
            text: "[NO TOOL CALL — model responded conversationally]",
          });
        }
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
   * The tool call already returned a quick acknowledgment so the voice
   * agent can speak immediately. When the orchestrator responds, inject
   * the result and trigger a follow-up response.
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
          text: `[ORCHESTRATOR RESULT] ${spokenResult || "(empty)"}`,
        });
        if (!spokenResult || spokenResult === "Working on it.") return;
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
        console.error("[realtime-voice] Orchestrator delegation error:", err);
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
                text: `[System: ${resultText}]\n\nSummarize these results for the user conversationally. Be concise.`,
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
                text: `[System: Web search failed: ${(err as Error).message}]. Let the user know briefly.`,
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
      } else if (name === "perform_action") {
        // Delegate to orchestrator. Use the user's actual transcript
        // instead of the model's paraphrase for better fidelity.
        const message =
          this.lastUserTranscript || (args.message as string) || "";
        result = "Working on it.";
        this.runPerformActionAsync(message);
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

    // For async calls (perform_action, web_search), don't request a response here —
    // the async handler will inject the real result and trigger response.create.
    if (name !== "perform_action" && name !== "web_search") {
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
    }
    this.outputAnalyser = null;
    if (this.outputMonitorSource) {
      this.outputMonitorSource.disconnect();
    }
    this.outputMonitorSource = null;
    this.pendingRemoteStream = null;

    this.assistantTranscriptBuffer = "";
    this.model = null;
  }
}
