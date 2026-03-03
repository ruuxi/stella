import { useEffect, useRef, useState } from "react";
import {
  RealtimeVoiceSession,
  claimPreWarmedSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "../services/realtime-voice";
import { useUiState } from "../app/state/ui-state";
import { useWindowType } from "./use-window-type";
import { useChatStore } from "../app/state/chat-store";
import { getOrCreateDeviceId } from "../services/device";

interface UseRealtimeVoiceResult {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isConnected: boolean;
  sessionState: VoiceSessionState;
}

const SESSION_ROTATE_MS = 55 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export function useRealtimeVoice(): UseRealtimeVoiceResult {
  const { state } = useUiState();
  const chatStore = useChatStore();
  const [sessionState, setSessionState] = useState<VoiceSessionState>("idle");

  const analyserRef = useRef<AnalyserNode | null>(null);
  const sessionRef = useRef<RealtimeVoiceSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const deviceIdRef = useRef<string | null>(null);
  const windowType = useWindowType();
  const isSessionOwnerWindow = windowType === "overlay" || state.window === windowType;
  const conversationId = state.conversationId ?? "voice-rtc";
  const conversationIdRef = useRef<string>(conversationId);
  const inputActiveRef = useRef<boolean>(state.isVoiceRtcActive);
  const appendEventRef = useRef(chatStore.appendEvent);

  // Keep appendEvent ref current without re-triggering effects
  useEffect(() => {
    appendEventRef.current = chatStore.appendEvent;
  }, [chatStore.appendEvent]);

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

  useEffect(() => {
    if (!isSessionOwnerWindow) return;

    let aborted = false;

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const clearRotateTimer = () => {
      if (rotateTimerRef.current) {
        clearTimeout(rotateTimerRef.current);
        rotateTimerRef.current = null;
      }
    };

    const teardownSession = async () => {
      clearRetryTimer();
      clearRotateTimer();
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) {
        await current.disconnect().catch(() => {});
      }
    };

    const scheduleRotate = () => {
      clearRotateTimer();
      rotateTimerRef.current = setTimeout(() => {
        if (aborted) return;
        void startSession(false);
      }, SESSION_ROTATE_MS);
    };

    const scheduleRetry = () => {
      clearRetryTimer();
      const delayMs = Math.min(
        RETRY_BASE_MS * Math.max(1, 2 ** retryAttemptRef.current),
        RETRY_MAX_MS,
      );
      retryAttemptRef.current += 1;
      retryTimerRef.current = setTimeout(() => {
        if (aborted) return;
        void startSession(false);
      }, delayMs);
    };

    const persistTranscript = (role: "user" | "assistant", text: string) => {
      const cid = conversationIdRef.current;
      if (!cid) return;

      // 1. Persist to JSONL store (orchestrator context) via IPC
      try {
        window.electronAPI?.persistVoiceTranscript?.({
          conversationId: cid,
          role,
          text,
        });
      } catch (err) {
        console.warn("[useRealtimeVoice] Failed to persist voice transcript to JSONL:", err);
      }

      // 2. Persist to localStorage (UI display)
      const type = role === "user" ? "user_message" : "assistant_message";
      const payload: Record<string, unknown> = { text, source: "voice" };
      const args: Parameters<typeof appendEventRef.current>[0] = {
        conversationId: cid,
        type,
        payload,
        ...(role === "user" && deviceIdRef.current
          ? { deviceId: deviceIdRef.current }
          : {}),
      };
      appendEventRef.current(args).catch((err) => {
        console.warn("[useRealtimeVoice] Failed to persist voice transcript to local store:", err);
      });
    };

    const attachSession = (session: RealtimeVoiceSession) => {
      sessionRef.current = session;
      session.setConversationId(conversationIdRef.current);
      session.setInputActive(inputActiveRef.current);

      unsubscribeRef.current = session.on((event: VoiceSessionEvent) => {
        if (aborted) return;

        if (event.type === "state-change") {
          setSessionState(event.state);
          analyserRef.current = session.getAnalyser();
          if (event.state === "connected") {
            retryAttemptRef.current = 0;
            scheduleRotate();
          } else if (event.state === "error") {
            clearRotateTimer();
            scheduleRetry();
          }
          return;
        }

        // Persist finalized voice transcripts as conversation events
        if (event.type === "user-transcript" && event.isFinal && event.text) {
          persistTranscript("user", event.text);
        } else if (event.type === "assistant-transcript" && event.isFinal && event.text) {
          persistTranscript("assistant", event.text);
        }
      });
    };

    const startSession = async (allowPreWarmed: boolean) => {
      clearRetryTimer();
      clearRotateTimer();

      const targetConversationId = conversationIdRef.current;
      const preWarmed = allowPreWarmed
        ? claimPreWarmedSession(targetConversationId)
        : null;
      const session = preWarmed ?? new RealtimeVoiceSession();
      console.log(`[VoiceRTC:hook] start session preWarmed=${!!preWarmed} window=${windowType}`);

      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      const previous = sessionRef.current;
      sessionRef.current = null;
      if (previous && previous !== session) {
        await previous.disconnect().catch(() => {});
      }
      if (aborted) {
        await session.disconnect().catch(() => {});
        return;
      }

      attachSession(session);

      if (preWarmed) {
        queueMicrotask(() => {
          if (aborted) return;
          setSessionState(session.state);
          if (session.state === "connected") {
            analyserRef.current = session.getAnalyser();
            retryAttemptRef.current = 0;
            scheduleRotate();
          } else if (session.state === "error") {
            scheduleRetry();
          }
        });
        return;
      }

      try {
        await session.connect(targetConversationId);
      } catch (err) {
        if (aborted) return;
        console.error("[useRealtimeVoice] Failed to connect:", err);
        setSessionState("error");
        scheduleRetry();
      }
    };

    void startSession(true);

    return () => {
      aborted = true;
      analyserRef.current = null;
      setSessionState("idle");
      void teardownSession();
    };
  }, [isSessionOwnerWindow, windowType]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.setConversationId(conversationId);
    session.setInputActive(state.isVoiceRtcActive);
  }, [conversationId, state.isVoiceRtcActive]);

  return {
    analyserRef,
    isConnected: sessionState === "connected",
    sessionState,
  };
}
