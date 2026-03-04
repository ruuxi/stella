import { useEffect, useRef, useState } from "react";
import {
  RealtimeVoiceSession,
  claimPreWarmedSession,
  initRealtimeVoiceIpc,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "../services/realtime-voice";
import { useUiState } from "../app/state/ui-state";
import { useWindowType } from "./use-window-type";
import { useOptionalChatStore } from "../app/state/chat-store";
import { getOrCreateDeviceId } from "../services/device";
import { appendLocalEvent } from "../services/local-chat-store";

interface UseRealtimeVoiceResult {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isConnected: boolean;
  sessionState: VoiceSessionState;
}

const SESSION_ROTATE_MS = 55 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

const appendEventLocalFallback = async (args: {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
}) => {
  appendLocalEvent(args);
  return null;
};

// ---------------------------------------------------------------------------
// VoiceSessionManager — extracted session lifecycle logic (no React imports)
// ---------------------------------------------------------------------------

interface VoiceSessionManagerDeps {
  conversationIdRef: { current: string };
  inputActiveRef: { current: boolean };
  appendEventRef: { current: (...args: any[]) => any };
  deviceIdRef: { current: string | null };
  analyserRef: { current: AnalyserNode | null };
  onStateChange: (state: VoiceSessionState) => void;
}

export class VoiceSessionManager {
  private deps: VoiceSessionManagerDeps;
  private sessionRef: { current: RealtimeVoiceSession | null } = { current: null };
  private unsubscribeRef: { current: (() => void) | null } = { current: null };
  private retryTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  private rotateTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
  private retryAttemptRef: { current: number } = { current: 0 };
  private aborted = false;

  constructor(deps: VoiceSessionManagerDeps) {
    this.deps = deps;
  }

  /** Boot the session lifecycle. */
  start(): void {
    this.aborted = false;
    void this.startSession(true);
  }

  /** Tear down everything and mark aborted. */
  stop(): void {
    this.aborted = true;
    this.deps.analyserRef.current = null;
    this.deps.onStateChange("idle");
    void this.teardownSession();
  }

  /** Forward conversationId / inputActive changes to the live session. */
  updateSession(conversationId: string, inputActive: boolean): void {
    const session = this.sessionRef.current;
    if (!session) return;
    session.setConversationId(conversationId);
    session.setInputActive(inputActive);
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

  private scheduleRotate(): void {
    this.clearRotateTimer();
    this.rotateTimerRef.current = setTimeout(() => {
      if (this.aborted) return;
      void this.startSession(false);
    }, SESSION_ROTATE_MS);
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

  private attachSession(session: RealtimeVoiceSession): void {
    this.sessionRef.current = session;
    session.setConversationId(this.deps.conversationIdRef.current);
    session.setInputActive(this.deps.inputActiveRef.current);

    this.unsubscribeRef.current = session.on((event: VoiceSessionEvent) => {
      if (this.aborted) return;

      if (event.type === "state-change") {
        this.deps.onStateChange(event.state);
        this.deps.analyserRef.current = session.getAnalyser();
        if (event.state === "connected") {
          this.retryAttemptRef.current = 0;
          this.scheduleRotate();
        } else if (event.state === "error") {
          this.clearRotateTimer();
          this.scheduleRetry();
        }
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

  private async startSession(allowPreWarmed: boolean): Promise<void> {
    this.clearRetryTimer();
    this.clearRotateTimer();

    const targetConversationId = this.deps.conversationIdRef.current;
    const preWarmed = allowPreWarmed
      ? claimPreWarmedSession(targetConversationId)
      : null;
    const session = preWarmed ?? new RealtimeVoiceSession();

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

    this.attachSession(session);

    if (preWarmed) {
      queueMicrotask(() => {
        if (this.aborted) return;
        this.deps.onStateChange(session.state);
        if (session.state === "connected") {
          this.deps.analyserRef.current = session.getAnalyser();
          this.retryAttemptRef.current = 0;
          this.scheduleRotate();
        } else if (session.state === "error") {
          this.scheduleRetry();
        }
      });
      return;
    }

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
  initRealtimeVoiceIpc();
  const { state } = useUiState();
  const chatStore = useOptionalChatStore();
  const [sessionState, setSessionState] = useState<VoiceSessionState>("idle");

  const analyserRef = useRef<AnalyserNode | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const windowType = useWindowType();
  const isSessionOwnerWindow = windowType === "overlay" || state.window === windowType;
  const conversationId = state.conversationId ?? "voice-rtc";
  const conversationIdRef = useRef<string>(conversationId);
  const inputActiveRef = useRef<boolean>(state.isVoiceRtcActive);
  const appendEventRef = useRef(chatStore?.appendEvent ?? appendEventLocalFallback);
  const managerRef = useRef<VoiceSessionManager | null>(null);

  // Keep appendEvent ref current without re-triggering effects
  useEffect(() => {
    appendEventRef.current = chatStore?.appendEvent ?? appendEventLocalFallback;
  }, [chatStore]);

  // Resolve deviceId once on mount
  useEffect(() => {
    void getOrCreateDeviceId().then((id) => {
      deviceIdRef.current = id;
    });
  }, []);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    inputActiveRef.current = state.isVoiceRtcActive;
  }, [state.isVoiceRtcActive]);

  // Main lifecycle effect — create manager, start, return cleanup
  useEffect(() => {
    if (!isSessionOwnerWindow) return;

    const manager = new VoiceSessionManager({
      conversationIdRef,
      inputActiveRef,
      appendEventRef,
      deviceIdRef,
      analyserRef,
      onStateChange: setSessionState,
    });
    managerRef.current = manager;
    manager.start();

    return () => {
      manager.stop();
      managerRef.current = null;
    };
  }, [isSessionOwnerWindow, windowType]);

  // Forward conversationId / inputActive changes to the live session
  useEffect(() => {
    managerRef.current?.updateSession(conversationId, state.isVoiceRtcActive);
  }, [conversationId, state.isVoiceRtcActive]);

  return {
    analyserRef,
    isConnected: sessionState === "connected",
    sessionState,
  };
}
