/**
 * RealtimeVoiceSession — transport-agnostic session orchestration for
 * Stella's realtime voice agent.
 *
 * Responsibilities (lifted from the previous monolithic realtime-voice.ts):
 *   - Lifecycle / state machine (idle → connecting → connected → …).
 *   - Server event routing (transcripts, tool calls, response.done).
 *   - Echo guard: monitors mic + assistant output analysers and applies a
 *     soft input mute when the assistant's voice is leaking into the mic.
 *   - Direct runtime tool dispatch for the resolved orchestrator tool catalog,
 *     plus `no_response` and goodbye/close session controls.
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

import { postServiceJson } from "@/platform/http/service-request";
import { getVoiceSessionPromptConfig } from "@/prompts";
import {
  formatRealtimeSystemMessage,
} from "../../../../../../runtime/contracts/system-reminders.js";
import type {
  RuntimeVoiceHistoryItem,
  RuntimeVoiceToolMetadata,
} from "../../../../../../runtime/protocol/index.js";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";
import type { EventRecord } from "../../../../../../runtime/contracts/local-chat.js";
import { createRealtimeTransport } from "./providers/provider-registry";
import type { RealtimeProviderKey, VoiceSessionToken } from "./providers/types";
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
const STELLA_VOICE_LEASE_HEARTBEAT_MS = 15_000;
const STELLA_VOICE_LEASE_EXPIRY_SKEW_MS = 1_000;
const VOICE_SESSION_CONTROL_TOOLS: RuntimeVoiceToolMetadata[] = [
  {
    type: "function",
    name: "no_response",
    description:
      "Use when the latest audio should not get a spoken response: silence, background noise, side conversation, filler sounds, thinking aloud, or an unfinished sentence.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "goodbye",
    description:
      "Use when the user clearly ends the voice session, such as saying bye, goodbye, see you later, or goodnight. Say one short goodbye first, then call this tool.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

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

const mergeVoiceSessionTools = (
  tools: RuntimeVoiceToolMetadata[] | undefined,
): RuntimeVoiceToolMetadata[] => {
  const out: RuntimeVoiceToolMetadata[] = [];
  const seen = new Set<string>();
  for (const tool of [...(tools ?? []), ...VOICE_SESSION_CONTROL_TOOLS]) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
};

const formatVoiceHistoryRole = (role: string): string => {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Stella";
    case "toolResult":
      return "Tool result";
    case "runtimeInternal":
      return "Runtime note";
    default:
      return role.trim() || "Message";
  }
};

const formatVoiceHistoryTimestamp = (timestamp: unknown): string => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return ` @ ${date.toISOString()}`;
};

export const buildVoiceConversationHistoryBlock = (
  history: RuntimeVoiceHistoryItem[] | undefined,
): string | null => {
  const entries = (history ?? [])
    .map((item) => {
      const content = item.content.trim();
      if (!content) return null;
      const label = formatVoiceHistoryRole(item.role);
      const timestamp = formatVoiceHistoryTimestamp(item.timestamp);
      const indented = content
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `[${label}${timestamp}]\n${indented}`;
    })
    .filter((item): item is string => item !== null);

  if (entries.length === 0) return null;
  return [
    '<conversation_history source="stella-chat" newest_last="true">',
    "These are prior messages and tool results in the current Stella conversation. Treat them as already-known chat history, not as a new request.",
    ...entries,
    "</conversation_history>",
  ].join("\n\n");
};

const buildVoiceSessionInstructions = async (
  orchestratorInstructions?: string,
  history?: RuntimeVoiceHistoryItem[],
): Promise<string> => {
  const coreMemory = await Promise.resolve(
    window.electronAPI?.voice.getCoreMemory?.(),
  ).catch(() => null);
  const trimmed = coreMemory?.trim();
  const base = getVoiceSessionPromptConfig().basePrompt;
  const sections = [base];
  const trimmedOrchestratorInstructions = orchestratorInstructions?.trim();
  if (trimmedOrchestratorInstructions) {
    sections.push(
      [
        "<text_orchestrator_context>",
        trimmedOrchestratorInstructions,
        "</text_orchestrator_context>",
      ].join("\n"),
    );
  }
  const historyBlock = buildVoiceConversationHistoryBlock(history);
  if (historyBlock) {
    sections.push(historyBlock);
  }
  if (trimmed) {
    sections.push(
      `<memory_file path="~/.stella/core-memory.md">\n${trimmed}\n</memory_file>`,
    );
  }
  return sections.join("\n\n");
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class RealtimeVoiceSession {
  private transport: RealtimeTransport | null = null;
  private sessionToken: VoiceSessionToken | null = null;
  private sessionProvider: RealtimeProviderKey = "stella";
  private readonly requestId =
    globalThis.crypto?.randomUUID?.() ??
    `voice-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  private destroyed = false;
  private inputActive = false;
  private assistantOutputActive = false;
  private recentOutputActiveUntil = 0;
  private softInputMuted = false;
  private echoGuardTimer: ReturnType<typeof setInterval> | null = null;
  private inputEnergyBuffer: Uint8Array | null = null;
  private outputEnergyBuffer: Uint8Array | null = null;

  private unsubscribeLocalChatUpdated: (() => void) | null = null;
  private syncedLocalEventIds = new Set<string>();
  private localChatSyncPromise: Promise<void> = Promise.resolve();
  private leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTerminalReported = false;

  private _state: VoiceSessionState = "idle";
  private listeners = new Set<VoiceSessionListener>();
  private conversationId: string | null = null;

  constructor() {
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
      const orchestratorConfig =
        await window.electronAPI?.voice
          .getOrchestratorConfig?.({ conversationId })
          .catch((err) => {
            console.debug(
              "[realtime-voice] Failed to load orchestrator config:",
              (err as Error).message,
            );
            return null;
          });
      const tools = mergeVoiceSessionTools(orchestratorConfig?.tools);
      const instructions = await buildVoiceSessionInstructions(
        orchestratorConfig?.instructions,
        orchestratorConfig?.history,
      );
      if (this.destroyed) return;

      const { transport, token, providerKey } = await createRealtimeTransport({
        conversationId,
        instructions,
        tools,
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
            void this.reportLeaseEvent("lost");
            this.cleanupAfterConnectionLoss();
            this.setState("error", reason || "Connection lost");
          }
        },
      });
      if (this.destroyed) {
        await transport.disconnect().catch(() => undefined);
        return;
      }

      await this.syncLocalChatContext({
        markExisting: true,
        includeVoiceSource: true,
        suppressAnnouncements: true,
      });
      await transport.setMicEnabled(this.inputActive);

      getVoiceRuntimeState().activeSession = this;
      this.startLeaseReporting();
      this.setState("connected");
    } catch (err) {
      if (this.destroyed) return;
      await this.transport?.disconnect().catch(() => undefined);
      this.transport = null;
      this.sessionToken = null;
      // A session that never reached "connected" must not retain the localChat
      // IPC listener wired up in the constructor. tearDown()/disconnect() also
      // clears it, but drop it here too so a leaked session (never disconnected)
      // can't keep the subscription alive for the app's lifetime.
      this.unsubscribeLocalChatUpdated?.();
      this.unsubscribeLocalChatUpdated = null;
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
    injectExisting?: boolean;
    includeVoiceSource?: boolean;
    suppressAnnouncements?: boolean;
  }): Promise<void> {
    this.localChatSyncPromise = this.localChatSyncPromise
      .catch(() => undefined)
      .then(async () => {
        const markOnly =
          options?.markExisting === true && options.injectExisting !== true;
        if (this.destroyed || !this.conversationId) {
          return;
        }
        if (!markOnly && this._state !== "connected") {
          return;
        }
        const api = window.electronAPI?.localChat;
        if (!api?.listMessages || !api?.listActivity) return;

        // Voice context sync merges the user/assistant message stream
        // with the agent-* activity stream. Pulling each source from
        // its purpose-built window keeps this off the legacy event
        // feed and reuses the same SQLite paths the chat surfaces use.
        const [messagesWindow, activityWindow] = await Promise.all([
          api.listMessages({
            conversationId: this.conversationId,
            maxVisibleMessages: VOICE_CONTEXT_SYNC_EVENT_LIMIT,
          }),
          api.listActivity({
            conversationId: this.conversationId,
            limit: VOICE_CONTEXT_SYNC_EVENT_LIMIT,
          }),
        ]);

        const events: EventRecord[] = [];
        for (const message of messagesWindow.messages) events.push(message);
        for (const activity of activityWindow.activities) events.push(activity);
        events.sort((a, b) => {
          if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
          return a._id.localeCompare(b._id);
        });

        if (markOnly) {
          for (const event of events) {
            this.syncedLocalEventIds.add(event._id);
          }
          return;
        }

        for (const event of events) {
          if (this.syncedLocalEventIds.has(event._id)) continue;
          this.syncedLocalEventIds.add(event._id);
          this.injectLocalChatEvent(event, {
            includeVoiceSource: options?.includeVoiceSource === true,
            suppressAnnouncement: options?.suppressAnnouncements === true,
          });
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

  private injectLocalChatEvent(
    event: EventRecord,
    options?: {
      includeVoiceSource?: boolean;
      suppressAnnouncement?: boolean;
    },
  ) {
    const mapped = this.mapLocalChatEventForVoice(event, {
      includeVoiceSource: options?.includeVoiceSource === true,
    });
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
    if (mapped.announce && !options?.suppressAnnouncement) {
      this.sendEvent({ type: "response.create" });
    }
  }

  private mapLocalChatEventForVoice(
    event: EventRecord,
    options?: { includeVoiceSource?: boolean },
  ): { text: string; announce: boolean } | null {
    if (VOICE_SYNC_IGNORED_EVENT_TYPES.has(event.type)) return null;

    const payload = event.payload ?? {};
    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return null;
      const isVoiceSource = payload.source === "voice";
      if (isVoiceSource && !options?.includeVoiceSource) return null;
      const speaker = isVoiceSource
        ? event.type === "user_message"
          ? "Prior voice user"
          : "Prior voice assistant"
        : event.type === "user_message"
          ? "User"
          : "Text orchestrator";
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
    const stellaSessionId = this.sessionToken?.stellaSessionId ?? null;

    if (!usage || !responseId || !model || this.sessionProvider !== "stella") {
      return;
    }

    try {
      await postServiceJson<unknown>(
        "/api/voice/usage",
        {
          responseId,
          model,
          ...(stellaSessionId ? { stellaSessionId } : {}),
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

  private async reportLeaseEvent(
    event: "heartbeat" | "ended" | "expired" | "lost",
  ) {
    const stellaSessionId = this.sessionToken?.stellaSessionId;
    if (!stellaSessionId || this.sessionProvider !== "stella") return;
    if (event !== "heartbeat") {
      if (this.leaseTerminalReported) return;
      this.leaseTerminalReported = true;
    }

    try {
      await postServiceJson<unknown>(
        "/api/voice/lease",
        {
          stellaSessionId,
          event,
        },
        { parseResponse: false },
      );
    } catch (err) {
      console.debug(
        "[realtime-voice] Failed to report voice lease event:",
        (err as Error).message,
      );
    }
  }

  private startLeaseReporting() {
    if (
      this.sessionProvider !== "stella" ||
      !this.sessionToken?.stellaSessionId
    ) {
      return;
    }

    this.stopLeaseReporting();
    void this.reportLeaseEvent("heartbeat");
    this.leaseHeartbeatTimer = setInterval(() => {
      void this.reportLeaseEvent("heartbeat");
    }, STELLA_VOICE_LEASE_HEARTBEAT_MS);

    const leaseExpiresAt = this.sessionToken.leaseExpiresAt;
    if (typeof leaseExpiresAt === "number" && Number.isFinite(leaseExpiresAt)) {
      const delayMs = Math.max(
        0,
        leaseExpiresAt - Date.now() - STELLA_VOICE_LEASE_EXPIRY_SKEW_MS,
      );
      this.leaseExpiryTimer = setTimeout(() => {
        this.handleLeaseExpired();
      }, delayMs);
    }
  }

  private stopLeaseReporting() {
    if (this.leaseHeartbeatTimer) {
      clearInterval(this.leaseHeartbeatTimer);
      this.leaseHeartbeatTimer = null;
    }
    if (this.leaseExpiryTimer) {
      clearTimeout(this.leaseExpiryTimer);
      this.leaseExpiryTimer = null;
    }
  }

  private handleLeaseExpired() {
    if (this.destroyed) return;
    if (this._state !== "connected" && this._state !== "connecting") return;
    void this.reportLeaseEvent("expired");
    this.cleanupAfterConnectionLoss();
    this.setState("error", "Realtime voice lease expired");
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

  private async runRuntimeToolCall(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    const api = window.electronAPI?.voice;
    if (!api?.executeTool || !this.conversationId) {
      throw new Error("Stella runtime tools are not available.");
    }
    const result = await api.executeTool({
      requestId: this.requestId,
      conversationId: this.conversationId,
      callId,
      name,
      args,
    });
    return result.output || (result.error ? `Error: ${result.error}` : "ok");
  }

  private async handleFunctionCall(item: Record<string, unknown>) {
    const name = item.name as string;
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
      } else {
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
        result = await this.runRuntimeToolCall(name, args, callId);
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

    this.sendEvent({ type: "response.create" });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private async tearDown() {
    this.stopLeaseReporting();
    await this.reportLeaseEvent("ended");
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;

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
    this.stopLeaseReporting();
    this.stopEchoGuardMonitor();
    this.assistantOutputActive = false;
    this.recentOutputActiveUntil = 0;
    this.softInputMuted = false;

    this.unsubscribeLocalChatUpdated?.();
    this.unsubscribeLocalChatUpdated = null;

    if (this.transport) {
      void this.transport.disconnect().catch(() => undefined);
      this.transport = null;
    }
  }
}
