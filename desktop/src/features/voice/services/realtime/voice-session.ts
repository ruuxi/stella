/**
 * RealtimeVoiceSession — transport-agnostic session orchestration for
 * Stella's realtime voice agent.
 *
 * Responsibilities (lifted from the previous monolithic realtime-voice.ts):
 *   - Lifecycle / state machine (idle → connecting → connected → …).
 *   - Server event routing (transcripts, tool calls, response.done).
 *   - Echo guard: monitors mic + assistant output analysers and applies a
 *     soft input mute when the assistant's voice is leaking into the mic.
 *   - Tool dispatch for `perform_action`, `web_search`, `look_at_screen`,
 *     `no_response`, `goodbye`/`close`.
 *   - Local-chat sync: surfaces user/assistant messages and delegated-
 *     agent state changes from the text chat into the voice conversation.
 *   - Usage reporting (Stella-managed path only).
 *   - Goodbye-phrase detection that hangs up the live turn while leaving
 *     the warm session attached for the next wake-word.
 *
 * What it deliberately does NOT do:
 *   - Open RTCPeerConnection / WebSocket. That's the transport.
 *   - Capture mic audio or schedule speaker playback. That's the transport.
 *   - Decide which provider to use. That's `providers/provider-registry.ts`.
 *
 * Picking a transport happens in `connect()` via the provider registry,
 * which reads the user's `realtimeVoice.provider` preference and returns a
 * pre-configured transport plus its session token. Once we have the
 * transport, the session subscribes to its `onEvent` callback and uses
 * `transport.send(...)` for everything else — both paths look identical
 * from here on.
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
} from "../../../../../../runtime/contracts/system-reminders.js";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";
import type { EventRecord } from "../../../../../../runtime/contracts/local-chat.js";
import { createRealtimeTransport } from "./providers/provider-registry";
import type {
  RealtimeProviderKey,
  VoiceSessionToken,
} from "./providers/types";
import type { RealtimeTransport } from "./transports/types";

// ---------------------------------------------------------------------------
// Public types
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

// ---------------------------------------------------------------------------
// Echo guard tuning
// ---------------------------------------------------------------------------

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

const buildVoiceSessionInstructions = async (): Promise<string> => {
  const coreMemory = await Promise.resolve(
    window.electronAPI?.voice.getCoreMemory?.(),
  ).catch(() => null);
  const trimmed = coreMemory?.trim();
  const base = getVoiceSessionPromptConfig().basePrompt;
  return trimmed
    ? `${base}\n\n<memory_file path="state/core-memory.md">\n${trimmed}\n</memory_file>`
    : base;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private transport: RealtimeTransport | null = null;
  private sessionToken: VoiceSessionToken | null = null;
  private sessionProvider: RealtimeProviderKey = "stella";

  private destroyed = false;
  private inputActive = false;
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
   * Session stays connected; transport-level mic capture is suspended
   * while inactive.
   */
  setInputActive(active: boolean) {
    this.inputActive = active;
    void this.transport?.setMicEnabled(active).catch((err) => {
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
      const instructions = await buildVoiceSessionInstructions();
      if (this.destroyed) return;

      const { transport, token, providerKey } = await createRealtimeTransport({
        conversationId,
        instructions,
      });
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        return;
      }

      this.transport = transport;
      this.sessionToken = token;
      this.sessionProvider = providerKey;

      await transport.connect({
        onEvent: (event) => this.handleServerEvent(event),
        onClose: (reason) => {
          if (this._state === "connected" || this._state === "connecting") {
            this.cleanupAfterConnectionLoss();
            this.setState("error", reason || "Connection lost");
          }
        },
      });
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        return;
      }

      await transport.setMicEnabled(this.inputActive);

      getVoiceRuntimeState().activeSession = this;
      this.setState("connected");
      void this.syncLocalChatContext({ markExisting: true });
    } catch (err) {
      if (this.destroyed) return;
      await this.transport?.disconnect().catch(() => undefined);
      this.transport = null;
      this.sessionToken = null;
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
    await this.tearDown();
    this.setState("idle");
  }

  /** Get the mic input analyser node for visualization. */
  getAnalyser(): AnalyserNode | null {
    return this.transport?.getMicAnalyser() ?? null;
  }

  /** Get the output (assistant voice) analyser node for visualization. */
  getOutputAnalyser(): AnalyserNode | null {
    return this.transport?.getOutputAnalyser() ?? null;
  }

  // ---------------------------------------------------------------------------
  // Echo guard
  // ---------------------------------------------------------------------------

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
    if (this.echoGuardTimer) return;
    this.echoGuardTimer = setInterval(() => {
      this.syncEchoGuard();
      // Echo guard only matters while assistant audio is (or was just)
      // playing — that's the only time the user's mic could be picking
      // up our own speech. Once we're past the release window, the
      // monitor has nothing useful to do, so let it idle even if the
      // mic is still hot. `output_audio.started` restarts it on the
      // next assistant turn.
      if (
        !this.assistantOutputActive &&
        this.recentOutputActiveUntil <= Date.now()
      ) {
        if (this.softInputMuted) this.applySoftInputMute(false);
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
    this.transport?.applySoftInputMute(shouldMute);
  }

  private syncEchoGuard() {
    const shouldMute =
      this.inputActive &&
      shouldGateVoiceInputForEcho({
        assistantSpeaking: this.assistantOutputActive,
        micLevel: this.getAnalyserEnergy(
          this.transport?.getMicAnalyser() ?? null,
          "input",
        ),
        outputLevel: this.getAnalyserEnergy(
          this.transport?.getOutputAnalyser() ?? null,
          "output",
        ),
        recentOutputActiveUntil: this.recentOutputActiveUntil,
      });

    if (this.softInputMuted !== shouldMute) {
      this.applySoftInputMute(shouldMute);
    }
  }

  // ---------------------------------------------------------------------------
  // Server event handling
  // ---------------------------------------------------------------------------

  private sendEvent(event: Record<string, unknown>) {
    this.transport?.send(event);
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
        if (!api?.listEvents) return;

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
          if (this.syncedLocalEventIds.has(event._id)) continue;
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
    if (!mapped) return;

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
    if (VOICE_SYNC_IGNORED_EVENT_TYPES.has(event.type)) return null;

    const payload = event.payload ?? {};
    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return null;
      if (payload.source === "voice") return null;
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
    const model = this.sessionToken?.model ?? null;

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

  private handleVoiceActionCompleted(payload: VoiceActionCompletedPayload) {
    if (this.destroyed) return;
    if (!this.inputActive) return;
    if (
      !this.conversationId ||
      payload.conversationId !== this.conversationId
    ) {
      return;
    }

    const message = payload.message.trim();
    if (!message) return;

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

      // xAI emits function calls as a top-level event rather than wrapped
      // inside response.output_item.done. Same payload shape (`name`,
      // `call_id`, `arguments`) so route both into the same handler.
      case "response.function_call_arguments.done": {
        void this.handleFunctionCall({
          type: "function_call",
          name: event.name,
          call_id: event.call_id,
          arguments: event.arguments,
        });
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
        if (output) void this.reportUsage(output);
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
      .webSearch({ query, category })
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
        this.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          },
        });
        this.emit({ type: "tool-end", name, callId, result: "ok" });
        // Goodbye ends the live turn immediately, but the warm session
        // stays connected so any in-flight assistant audio can finish.
        this.setInputActive(false);
        window.electronAPI?.ui.setState({ isVoiceRtcActive: false });
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

    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });

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

  private async tearDown() {
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;

    this.unsubscribeActionCompleted?.();
    this.unsubscribeActionCompleted = null;
    this.unsubscribeLocalChatUpdated?.();
    this.unsubscribeLocalChatUpdated = null;
    this.syncedLocalEventIds.clear();

    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (err) {
        console.debug(
          "[realtime-voice] Transport disconnect failed:",
          (err as Error).message,
        );
      }
      this.transport = null;
    }
    this.sessionToken = null;
    this.sessionProvider = "stella";
    this.inputEnergyBuffer = null;
    this.outputEnergyBuffer = null;
  }

  /** Tear down state without awaiting (used inside synchronous onClose paths). */
  private cleanupAfterConnectionLoss() {
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;

    if (this.transport) {
      void this.transport.disconnect().catch(() => undefined);
      this.transport = null;
    }
  }
}
