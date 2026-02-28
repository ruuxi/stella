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

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;

  // Accumulated transcript fragments
  private assistantTranscriptBuffer = "";

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

  async connect(conversationId: string): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`Cannot connect in state: ${this._state}`);
    }
    this.conversationId = conversationId;
    this.setState("connecting");

    try {
      // 1. Get ephemeral key from backend
      const { endpoint, headers } = await createServiceRequest("/api/voice/session");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      if (this.destroyed) return;
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Failed to create voice session: ${res.status} ${detail}`);
      }
      const { clientSecret, model } = (await res.json()) as {
        clientSecret: string;
        expiresAt?: number;
        model: string;
        voice: string;
      };

      if (this.destroyed) return;

      // 2. Get microphone
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      if (this.destroyed) {
        this.localStream.getTracks().forEach((t) => t.stop());
        this.localStream = null;
        return;
      }

      // 3. Create peer connection
      this.pc = new RTCPeerConnection();

      // Add mic track
      const audioTrack = this.localStream.getTracks()[0];
      this.pc.addTrack(audioTrack, this.localStream);

      // 4. Create data channel
      this.dc = this.pc.createDataChannel("oai-events");
      this.setupDataChannel();

      // 5. Handle remote audio (model's voice)
      this.pc.ontrack = (event) => {
        if (this.destroyed) return;
        const remoteStream = event.streams[0];
        if (remoteStream) {
          this.setupAudioPlayback(remoteStream);
        }
      };

      // 6. SDP negotiation with OpenAI using ephemeral key
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.destroyed) {
        this.cleanup();
        return;
      }

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

      if (this.destroyed) {
        this.cleanup();
        return;
      }

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

      if (this.destroyed) {
        this.cleanup();
        return;
      }

      // Setup audio analyser for visualization
      this.setupAudioAnalyser();

      this.setState("connected");
    } catch (err) {
      if (this.destroyed) return;
      console.error("[RealtimeVoice] connect failed:", err);
      this.cleanup();
      this.setState("error", (err as Error).message);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._state === "idle" || this._state === "disconnecting") return;
    this.destroyed = true;
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

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {
      console.log("[RealtimeVoice] data channel open");
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
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
    this.audioElement = new Audio();
    this.audioElement.srcObject = stream;
    this.audioElement.autoplay = true;
    this.audioElement.play().catch((err) => {
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
      case "session.updated":
        break;

      case "response.output_item.done": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          void this.handleFunctionCall(item);
        }
        break;
      }

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

      case "response.output_audio_transcript.done": {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
          this.emit({
            type: "assistant-transcript",
            text: transcript,
            isFinal: true,
          });
          void this.logTranscript("assistant_message", transcript);
          this.assistantTranscriptBuffer = "";
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = (event as { transcript?: string }).transcript;
        if (transcript) {
          this.emit({
            type: "user-transcript",
            text: transcript,
            isFinal: true,
          });
          void this.logTranscript("user_message", transcript);
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
  // Transcript logging
  // ---------------------------------------------------------------------------

  private async logTranscript(
    type: "user_message" | "assistant_message",
    content: string
  ) {
    if (!this.conversationId || !content.trim()) return;
    try {
      const { endpoint, headers } = await createServiceRequest("/api/voice/log");
      await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: this.conversationId,
          type,
          content,
        }),
      });
    } catch (err) {
      console.error("[RealtimeVoice] log transcript failed:", err);
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
  }
}
