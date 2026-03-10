import { useEffect, useState } from "react";
import {
  RealtimeVoiceSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/app/voice/services/realtime-voice";
import type { VoiceRuntimeSnapshot } from "@/types/electron";

interface UseRealtimeVoiceResult {
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  sessionState: VoiceSessionState;
  micLevel: number;
  outputLevel: number;
}

type VoiceEventAppendArgs = {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
};

const SESSION_ROTATE_MS = 55 * 60 * 1000;
const SESSION_ROTATE_IDLE_WAIT_MS = 30_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const DEFAULT_RUNTIME_STATE: VoiceRuntimeSnapshot = {
  sessionState: "idle",
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
};

// ---------------------------------------------------------------------------
// VoiceSessionManager — extracted session lifecycle logic (no React imports)
// ---------------------------------------------------------------------------

interface VoiceSessionManagerDeps {
  conversationIdRef: { current: string };
  inputActiveRef: { current: boolean };
  appendEventRef: { current: (args: VoiceEventAppendArgs) => unknown };
  deviceIdRef: { current: string | null };
  analyserRef: { current: AnalyserNode | null };
  outputAnalyserRef: { current: AnalyserNode | null };
  onStateChange: (state: VoiceSessionState) => void;
  onSpeakingChange: (isSpeaking: boolean) => void;
  onUserSpeakingChange: (isUserSpeaking: boolean) => void;
}

export class VoiceSessionManager {
  private deps: VoiceSessionManagerDeps;
  private sessionRef: { current: RealtimeVoiceSession | null } = { current: null };
  private unsubscribeRef: { current: (() => void) | null } = { current: null };
  private retryTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  private rotateTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  private retryAttemptRef: { current: number } = { current: 0 };
  private connectedConversationIdRef: { current: string | null } = { current: null };
  private aborted = false;

  constructor(deps: VoiceSessionManagerDeps) {
    this.deps = deps;
  }

  /** Boot the session lifecycle. */
  start(): void {
    this.aborted = false;
    void this.startSession();
  }

  /** Tear down everything and mark aborted. */
  stop(): void {
    this.aborted = true;
    this.deps.analyserRef.current = null;
    this.deps.outputAnalyserRef.current = null;
    this.deps.onSpeakingChange(false);
    this.deps.onUserSpeakingChange(false);
    this.deps.onStateChange("idle");
    void this.teardownSession();
  }

  /** Forward conversationId / inputActive changes to the live session. */
  updateSession(conversationId: string, inputActive: boolean): void {
    const session = this.sessionRef.current;
    if (!session) return;
    session.setConversationId(conversationId);
    session.setInputActive(inputActive);

    if (
      session.state === "connected"
      && this.connectedConversationIdRef.current
      && this.connectedConversationIdRef.current !== conversationId
      && !inputActive
    ) {
      this.scheduleRotate(0);
    }
  }

  // ---- private helpers ----------------------------------------------------

  private clearRetryTimer(): void {
    if (this.retryTimerRef.current) {
      clearTimeout(this.retryTimerRef.current);
      this.retryTimerRef.current = null;
    }
  }

  private clearRotateTimer(): void {
    if (this.rotateTimerRef.current) {
      clearTimeout(this.rotateTimerRef.current);
      this.rotateTimerRef.current = null;
    }
  }

  private async teardownSession(): Promise<void> {
    this.clearRetryTimer();
    this.clearRotateTimer();
    this.connectedConversationIdRef.current = null;
    if (this.unsubscribeRef.current) {
      this.unsubscribeRef.current();
      this.unsubscribeRef.current = null;
    }
    const current = this.sessionRef.current;
    this.sessionRef.current = null;
    if (current) {
      await current.disconnect().catch((err) => {
        console.debug('[VoiceSessionManager] Disconnect failed during teardown:', (err as Error).message);
      });
    }
  }

  private scheduleRotate(delayMs = SESSION_ROTATE_MS): void {
    this.clearRotateTimer();
    this.rotateTimerRef.current = setTimeout(() => {
      if (this.aborted) return;
      if (this.deps.inputActiveRef.current) {
        this.scheduleRotate(SESSION_ROTATE_IDLE_WAIT_MS);
        return;
      }
      void this.startSession(false);
    }, delayMs);
  }

  private scheduleRetry(): void {
    this.clearRetryTimer();
    const delayMs = Math.min(
      RETRY_BASE_MS * Math.max(1, 2 ** this.retryAttemptRef.current),
      RETRY_MAX_MS,
    );
    this.retryAttemptRef.current += 1;
    this.retryTimerRef.current = setTimeout(() => {
      if (this.aborted) return;
      void this.startSession(false);
    }, delayMs);
  }

  private persistTranscript(role: "user" | "assistant", text: string): void {
    const cid = this.deps.conversationIdRef.current;
    if (!cid) return;

    // 1. Persist to JSONL store (orchestrator context) via IPC
    try {
      window.electronAPI?.voice.persistTranscript?.({
        conversationId: cid,
        role,
        text,
      });
    } catch (err) {
      console.debug('[VoiceSessionManager] Voice persistence failed:', (err as Error).message);
    }

    // 2. Persist to localStorage (UI display)
    const type = role === "user" ? "user_message" : "assistant_message";
    const payload: Record<string, unknown> = { text, source: "voice" };
    const args: Parameters<typeof this.deps.appendEventRef.current>[0] = {
      conversationId: cid,
      type,
      payload,
      ...(role === "user" && this.deps.deviceIdRef.current
        ? { deviceId: this.deps.deviceIdRef.current }
        : {}),
    };
    Promise.resolve(this.deps.appendEventRef.current(args)).catch((err) => {
      console.debug('[VoiceSessionManager] Event persistence failed:', (err as Error).message);
    });
  }

  private attachSession(session: RealtimeVoiceSession, targetConversationId: string): void {
    this.sessionRef.current = session;
    session.setConversationId(this.deps.conversationIdRef.current);
    session.setInputActive(this.deps.inputActiveRef.current);

    this.unsubscribeRef.current = session.on((event: VoiceSessionEvent) => {
      if (this.aborted) return;

      // The remote output analyser is created after the session is already connected,
      // so refresh analyser refs on every event rather than only on state changes.
      this.deps.analyserRef.current = session.getAnalyser();
      this.deps.outputAnalyserRef.current = session.getOutputAnalyser();

      if (event.type === "state-change") {
        this.deps.onStateChange(event.state);
        if (event.state === "connected") {
          this.connectedConversationIdRef.current = targetConversationId;
          this.retryAttemptRef.current = 0;
          this.scheduleRotate();
          if (
            !this.deps.inputActiveRef.current
            && this.deps.conversationIdRef.current !== targetConversationId
          ) {
            this.scheduleRotate(0);
          }
        } else if (event.state === "error") {
          this.clearRotateTimer();
          this.connectedConversationIdRef.current = null;
          this.scheduleRetry();
        }
        return;
      }

      if (event.type === "speaking-start") {
        this.deps.onSpeakingChange(true);
        return;
      }
      if (event.type === "speaking-end") {
        this.deps.onSpeakingChange(false);
        return;
      }
      if (event.type === "user-speaking-start") {
        this.deps.onUserSpeakingChange(true);
        return;
      }
      if (event.type === "user-speaking-end") {
        this.deps.onUserSpeakingChange(false);
        return;
      }

      // Persist finalized voice transcripts as conversation events
      if (event.type === "user-transcript" && event.isFinal && event.text) {
        this.persistTranscript("user", event.text);
      } else if (event.type === "assistant-transcript" && event.isFinal && event.text) {
        this.persistTranscript("assistant", event.text);
      }
    });
  }

  private async startSession(): Promise<void> {
    this.clearRetryTimer();
    this.clearRotateTimer();

    const targetConversationId = this.deps.conversationIdRef.current;
    const session = new RealtimeVoiceSession();

    if (this.unsubscribeRef.current) {
      this.unsubscribeRef.current();
      this.unsubscribeRef.current = null;
    }
    const previous = this.sessionRef.current;
    this.sessionRef.current = null;
    if (previous && previous !== session) {
      await previous.disconnect().catch((err) => {
        console.debug('[VoiceSessionManager] Previous session disconnect failed:', (err as Error).message);
      });
    }
    if (this.aborted) {
      await session.disconnect().catch((err) => {
        console.debug('[VoiceSessionManager] Aborted session disconnect failed:', (err as Error).message);
      });
      return;
    }

    this.attachSession(session, targetConversationId);

    try {
      await session.connect(targetConversationId);
    } catch (err) {
      if (this.aborted) return;
      console.error("[VoiceSessionManager] Failed to connect:", (err as Error).message);
      this.deps.onStateChange("error");
      this.scheduleRetry();
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRealtimeVoice(): UseRealtimeVoiceResult {
  const [runtimeState, setRuntimeState] = useState<VoiceRuntimeSnapshot>(DEFAULT_RUNTIME_STATE);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.voice) {
      return;
    }

    void api.voice
      .getRuntimeState()
      .then((snapshot) => {
        setRuntimeState(snapshot);
      })
      .catch(() => {
        setRuntimeState(DEFAULT_RUNTIME_STATE);
      });

    const unsubscribe = api.voice.onRuntimeState((snapshot) => {
      setRuntimeState(snapshot);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return {
    isConnected: runtimeState.isConnected,
    isSpeaking: runtimeState.isSpeaking,
    isUserSpeaking: runtimeState.isUserSpeaking,
    sessionState: runtimeState.sessionState,
    micLevel: runtimeState.micLevel,
    outputLevel: runtimeState.outputLevel,
  };
}


