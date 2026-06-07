import { useEffect, useRef, useState, type RefObject } from "react";
import {
  RealtimeVoiceSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/features/voice/services/realtime-voice";
import type { VoiceRuntimeSnapshot } from "@/shared/types/electron";

interface UseRealtimeVoiceResult {
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  sessionState: VoiceSessionState;
  micLevel: number;
  outputLevel: number;
  micLevelRef: RefObject<number>;
  outputLevelRef: RefObject<number>;
}

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

export const shouldPersistVoiceTranscriptToHistory = (
  event: VoiceSessionEvent,
): event is Extract<
  VoiceSessionEvent,
  { type: "user-transcript" | "assistant-transcript" }
> =>
  (event.type === "user-transcript" ||
    event.type === "assistant-transcript") &&
  event.isFinal &&
  event.text.trim().length > 0;

export const formatVoiceSessionDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

// ---------------------------------------------------------------------------
// VoiceSessionManager — extracted session lifecycle logic (no React imports)
// ---------------------------------------------------------------------------

interface VoiceSessionManagerDeps {
  conversationIdRef: { current: string };
  inputActiveRef: { current: boolean };
  analyserRef: { current: AnalyserNode | null };
  outputAnalyserRef: { current: AnalyserNode | null };
  onStateChange: (state: VoiceSessionState, error?: string) => void;
  onSpeakingChange: (isSpeaking: boolean) => void;
  onUserSpeakingChange: (isUserSpeaking: boolean) => void;
}

export class VoiceSessionManager {
  private deps: VoiceSessionManagerDeps;
  private sessionRef: { current: RealtimeVoiceSession | null } = {
    current: null,
  };
  private unsubscribeRef: { current: (() => void) | null } = { current: null };
  private retryTimerRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  private rotateTimerRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };
  private retryAttemptRef: { current: number } = { current: 0 };
  private connectedConversationIdRef: { current: string | null } = {
    current: null,
  };
  private assistantSpeaking = false;
  private userSpeaking = false;
  private aborted = false;
  private startInFlight = false;
  private activeVoiceStartedAt: number | null = null;

  constructor(deps: VoiceSessionManagerDeps) {
    this.deps = deps;
  }

  /** Boot the session lifecycle. */
  start(): void {
    this.aborted = false;
    if (this.deps.inputActiveRef.current) {
      this.beginVisibleVoiceSession();
    }
    void this.startSession();
  }

  /** Tear down everything and mark aborted. */
  stop(): void {
    this.aborted = true;
    this.startInFlight = false;
    this.endVisibleVoiceSession();
    this.deps.analyserRef.current = null;
    this.deps.outputAnalyserRef.current = null;
    this.assistantSpeaking = false;
    this.userSpeaking = false;
    this.deps.onSpeakingChange(false);
    this.deps.onUserSpeakingChange(false);
    this.deps.onStateChange("idle");
    void this.teardownSession();
  }

  /** Forward conversationId / inputActive changes to the live session. */
  updateSession(conversationId: string, inputActive: boolean): void {
    const session = this.sessionRef.current;
    this.syncVisibleVoiceSessionState(inputActive);
    if (!session) return;
    session.setConversationId(conversationId);
    session.setInputActive(inputActive);

    if (
      session.state === "connected" &&
      this.connectedConversationIdRef.current &&
      this.connectedConversationIdRef.current !== conversationId &&
      !inputActive
    ) {
      this.scheduleRotate(0);
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.sessionRef.current?.getAnalyser() ?? null;
  }

  getOutputAnalyser(): AnalyserNode | null {
    return this.sessionRef.current?.getOutputAnalyser() ?? null;
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
        console.debug(
          "[VoiceSessionManager] Disconnect failed during teardown:",
          (err as Error).message,
        );
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
      if (this.isConversationBusy()) {
        this.scheduleRotate(SESSION_ROTATE_IDLE_WAIT_MS);
        return;
      }
      void this.startSession();
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
      if (this.isConversationBusy()) {
        this.scheduleRotate(SESSION_ROTATE_IDLE_WAIT_MS);
        return;
      }
      void this.startSession();
    }, delayMs);
  }

  private isConversationBusy(): boolean {
    return (
      this.deps.inputActiveRef.current ||
      this.assistantSpeaking ||
      this.userSpeaking
    );
  }

  private persistVoiceTranscript(
    role: "user" | "assistant",
    text: string,
    uiVisibility: "visible" | "hidden",
    voiceSession?: { durationMs: number },
  ): void {
    const cid = this.deps.conversationIdRef.current;
    if (!cid) return;

    try {
      window.electronAPI?.voice.persistTranscript?.({
        conversationId: cid,
        role,
        text,
        uiVisibility,
        ...(voiceSession ? { voiceSession } : {}),
      });
    } catch (err) {
      console.debug(
        "[VoiceSessionManager] Voice persistence failed:",
        (err as Error).message,
      );
    }
  }

  private persistHiddenVoiceTranscript(
    role: "user" | "assistant",
    text: string,
  ): void {
    this.persistVoiceTranscript(role, text, "hidden");
  }

  private beginVisibleVoiceSession(now = Date.now()): void {
    if (this.activeVoiceStartedAt !== null) return;
    this.activeVoiceStartedAt = now;
  }

  private endVisibleVoiceSession(now = Date.now()): void {
    const startedAt = this.activeVoiceStartedAt;
    if (startedAt === null) return;
    this.activeVoiceStartedAt = null;
    const durationMs = Math.max(0, now - startedAt);
    const duration = formatVoiceSessionDuration(durationMs);
    // The text body is the model-history fallback; the chat surface renders
    // the structured `voiceSession` metadata as a polished summary card.
    this.persistVoiceTranscript(
      "assistant",
      ["Voice session", "", `Duration: ${duration}`].join("\n"),
      "visible",
      { durationMs },
    );
  }

  private syncVisibleVoiceSessionState(inputActive: boolean): void {
    if (inputActive) {
      this.beginVisibleVoiceSession();
    } else {
      this.endVisibleVoiceSession();
    }
  }

  private attachLiveSession(
    session: RealtimeVoiceSession,
    targetConversationId: string,
  ): void {
    this.sessionRef.current = session;
    session.setConversationId(targetConversationId);
    session.setInputActive(this.deps.inputActiveRef.current);
    this.deps.analyserRef.current = session.getAnalyser();
    this.deps.outputAnalyserRef.current = session.getOutputAnalyser();
    this.connectedConversationIdRef.current = targetConversationId;
    this.retryAttemptRef.current = 0;
    this.assistantSpeaking = false;
    this.userSpeaking = false;
    this.deps.onSpeakingChange(false);
    this.deps.onUserSpeakingChange(false);
    this.deps.onStateChange("connected");
    this.scheduleRotate();
    if (
      !this.deps.inputActiveRef.current &&
      this.deps.conversationIdRef.current !== targetConversationId
    ) {
      this.scheduleRotate(0);
    }

    this.unsubscribeRef.current = session.on((event: VoiceSessionEvent) => {
      if (this.aborted) return;
      if (this.sessionRef.current !== session) return;

      this.deps.analyserRef.current = session.getAnalyser();
      this.deps.outputAnalyserRef.current = session.getOutputAnalyser();

      if (event.type === "state-change") {
        if (event.state === "error") {
          this.clearRotateTimer();
          this.connectedConversationIdRef.current = null;
          this.assistantSpeaking = false;
          this.userSpeaking = false;
          this.deps.onSpeakingChange(false);
          this.deps.onUserSpeakingChange(false);
          this.deps.onStateChange("error", event.error);
          this.scheduleRetry();
        } else {
          this.deps.onStateChange(event.state);
        }
        return;
      }

      if (event.type === "speaking-start") {
        this.assistantSpeaking = true;
        this.deps.onSpeakingChange(true);
        return;
      }
      if (event.type === "speaking-end") {
        this.assistantSpeaking = false;
        this.deps.onSpeakingChange(false);
        return;
      }
      if (event.type === "user-speaking-start") {
        this.userSpeaking = true;
        this.deps.onUserSpeakingChange(true);
        return;
      }
      if (event.type === "user-speaking-end") {
        this.userSpeaking = false;
        this.deps.onUserSpeakingChange(false);
        return;
      }

      if (shouldPersistVoiceTranscriptToHistory(event)) {
        this.persistHiddenVoiceTranscript(
          event.type === "user-transcript" ? "user" : "assistant",
          event.text,
        );
      }
    });
  }

  private async startSession(): Promise<void> {
    if (this.startInFlight || this.aborted) {
      return;
    }
    this.startInFlight = true;
    this.clearRetryTimer();
    this.clearRotateTimer();

    const targetConversationId = this.deps.conversationIdRef.current;
    let previousSession = this.sessionRef.current;
    let previousUnsubscribe = this.unsubscribeRef.current;

    if (previousSession && previousSession.state !== "connected") {
      if (previousUnsubscribe) {
        previousUnsubscribe();
      }
      this.unsubscribeRef.current = null;
      this.sessionRef.current = null;
      this.connectedConversationIdRef.current = null;
      previousUnsubscribe = null;
      await previousSession.disconnect().catch((err) => {
        console.debug(
          "[VoiceSessionManager] Stale session disconnect failed:",
          (err as Error).message,
        );
      });
      previousSession = null;
    }

    if (!previousSession) {
      this.assistantSpeaking = false;
      this.userSpeaking = false;
      this.deps.onSpeakingChange(false);
      this.deps.onUserSpeakingChange(false);
      this.deps.onStateChange("connecting");
    }

    const session = new RealtimeVoiceSession();
    session.setInputActive(this.deps.inputActiveRef.current);
    try {
      await session.connect(targetConversationId);
      if (this.aborted) {
        await session.disconnect().catch((err) => {
          console.debug(
            "[VoiceSessionManager] Aborted session disconnect failed:",
            (err as Error).message,
          );
        });
        return;
      }

      this.attachLiveSession(session, targetConversationId);

      if (previousSession && previousSession !== session) {
        previousSession.setInputActive(false);
        if (previousUnsubscribe) {
          previousUnsubscribe();
        }
        await previousSession.disconnect().catch((err) => {
          console.debug(
            "[VoiceSessionManager] Previous session disconnect failed:",
            (err as Error).message,
          );
        });
      }
    } catch (err) {
      if (this.aborted) return;
      console.error(
        "[VoiceSessionManager] Failed to connect:",
        (err as Error).message,
      );
      if (!previousSession) {
        this.deps.onStateChange("error", (err as Error).message);
      }
      this.scheduleRetry();
    } finally {
      this.startInFlight = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRealtimeVoice(): UseRealtimeVoiceResult {
  const [runtimeState, setRuntimeState] = useState<VoiceRuntimeSnapshot>(
    DEFAULT_RUNTIME_STATE,
  );
  const micLevelRef = useRef(DEFAULT_RUNTIME_STATE.micLevel);
  const outputLevelRef = useRef(DEFAULT_RUNTIME_STATE.outputLevel);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.voice) {
      return;
    }

    void api.voice
      .getRuntimeState()
      .then((snapshot) => {
        micLevelRef.current = snapshot.micLevel;
        outputLevelRef.current = snapshot.outputLevel;
        setRuntimeState(snapshot);
      })
      .catch(() => {
        micLevelRef.current = DEFAULT_RUNTIME_STATE.micLevel;
        outputLevelRef.current = DEFAULT_RUNTIME_STATE.outputLevel;
        setRuntimeState(DEFAULT_RUNTIME_STATE);
      });

    const unsubscribe = api.voice.onRuntimeState((snapshot) => {
      micLevelRef.current = snapshot.micLevel;
      outputLevelRef.current = snapshot.outputLevel;
      setRuntimeState((previous) => {
        if (
          previous.sessionState === snapshot.sessionState &&
          previous.isConnected === snapshot.isConnected &&
          previous.isSpeaking === snapshot.isSpeaking &&
          previous.isUserSpeaking === snapshot.isUserSpeaking
        ) {
          return previous;
        }
        return snapshot;
      });
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
    micLevelRef,
    outputLevelRef,
  };
}
