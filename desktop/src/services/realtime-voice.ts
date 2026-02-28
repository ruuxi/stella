/**
 * RealtimeVoiceSession — WebRTC session manager for OpenAI Realtime API.
 *
 * Manages the full lifecycle of a voice-to-voice session:
 * - WebRTC peer connection + audio I/O
 * - Data channel for sending/receiving JSON events
 * - Tool execution bridging (local IPC + backend HTTP)
 * - Task polling for subagent result delivery
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

/** Tools that execute locally via Electron IPC (toolHost). */
const LOCAL_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "TaskCreate",
  "TaskOutput",
  "TaskCancel",
]);

/** Tools that need backend execution via Convex HTTP (/api/voice/tool). */
const BACKEND_TOOLS = new Set([
  "RecallMemories",
  "SaveMemory",
  "OpenCanvas",
  "CloseCanvas",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "SpawnRemoteMachine",
]);

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

  // Active subagent tasks being polled
  private activeTasks = new Map<string, number>(); // taskId -> startedAt
  private taskPollTimer: ReturnType<typeof setInterval> | null = null;

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

      // Start task polling
      this.startTaskPolling();
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
    // Ensure playback starts
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
        // Session lifecycle — no action needed
        break;

      case "response.output_item.done": {
        // Check for function calls
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
          // Log assistant message to Convex
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
          // Log user message to Convex
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
        // Ignore unhandled event types
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Function call execution
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
      result = await this.executeTool(name, args);
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }

    this.emit({ type: "tool-end", name, callId, result });

    // Send function call output back
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });

    // Trigger model to continue
    this.sendEvent({ type: "response.create" });
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    // NoResponse — just return silently
    if (name === "NoResponse") {
      return "OK";
    }

    // Local tools — execute via Electron IPC
    if (LOCAL_TOOLS.has(name)) {
      const api = window.electronAPI;
      if (!api?.voiceRtcExecuteTool) {
        return `Error: Electron API not available for tool ${name}`;
      }
      const result = await api.voiceRtcExecuteTool(name, args);
      const resultStr = typeof result === "string"
        ? result
        : JSON.stringify(result ?? "OK");

      // Track subagent tasks for polling
      if (name === "TaskCreate") {
        const taskIdMatch = resultStr.match(/Task ID:\s*(\S+)/);
        if (taskIdMatch?.[1]) {
          this.activeTasks.set(taskIdMatch[1], Date.now());
        }
      }

      return resultStr;
    }

    // Backend tools — execute via Convex HTTP
    if (BACKEND_TOOLS.has(name)) {
      return await this.executeBackendTool(name, args);
    }

    return `Error: Unknown tool ${name}`;
  }

  private async executeBackendTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    return await this.callBackendToolAction(name, args);
  }

  private async callBackendToolAction(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const { endpoint, headers } = await createServiceRequest("/api/voice/tool");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: this.conversationId,
        toolName: name,
        toolArgs: args,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return `Error executing ${name}: ${errorText}`;
    }

    const data = (await res.json()) as { result?: string; error?: string };
    return data.result ?? data.error ?? "OK";
  }

  // ---------------------------------------------------------------------------
  // Task polling (for subagent results)
  // ---------------------------------------------------------------------------

  private startTaskPolling() {
    if (this.taskPollTimer) return;
    this.taskPollTimer = setInterval(() => {
      void this.checkActiveTasks();
    }, 3000);
  }

  private stopTaskPolling() {
    if (this.taskPollTimer) {
      clearInterval(this.taskPollTimer);
      this.taskPollTimer = null;
    }
  }

  private async checkActiveTasks() {
    if (this.activeTasks.size === 0) return;

    for (const [taskId] of this.activeTasks) {
      try {
        const result = await this.callBackendToolAction("TaskOutput", {
          task_id: taskId,
        });
        if (result.startsWith("Task completed.") || result.startsWith("Task failed.")) {
          this.activeTasks.delete(taskId);
          this.injectTaskResult(taskId, result);
        }
        // If still running, continue polling
      } catch (err) {
        console.error(
          `[RealtimeVoice] task poll error for ${taskId}:`,
          err
        );
      }
    }
  }

  private injectTaskResult(taskId: string, result: string) {
    // Inject result as a user-role message so the model responds to it
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `[System: Subagent task completed]\nTask ID: ${taskId}\n${result}`,
          },
        ],
      },
    });

    // Trigger the model to respond with the result
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
    this.stopTaskPolling();
    this.activeTasks.clear();

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
