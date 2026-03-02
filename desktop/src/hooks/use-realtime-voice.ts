import { useEffect, useRef, useState } from "react";
import {
  RealtimeVoiceSession,
  claimPreWarmedSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "../services/realtime-voice";
import { useUiState } from "../app/state/ui-state";
import { useWindowType } from "./use-window-type";

interface UseRealtimeVoiceResult {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isConnected: boolean;
  sessionState: VoiceSessionState;
}

export function useRealtimeVoice(): UseRealtimeVoiceResult {
  const { state } = useUiState();
  const [sessionState, setSessionState] = useState<VoiceSessionState>("idle");

  const analyserRef = useRef<AnalyserNode | null>(null);
  const sessionRef = useRef<RealtimeVoiceSession | null>(null);
  const windowType = useWindowType();

  useEffect(() => {
    if (!state.isVoiceRtcActive) return;

    // Only the active window should create a session — state.window tracks which
    // window is visible, so the hidden window skips session creation entirely.
    if (state.window !== windowType) return;

    // Disconnect any zombie session from a previous StrictMode mount
    if (sessionRef.current) {
      void sessionRef.current.disconnect();
      sessionRef.current = null;
    }

    let aborted = false;
    const conversationId = state.conversationId ?? "voice-rtc";

    // Try to claim a pre-warmed session (started from IPC before React rendered)
    const preWarmed = claimPreWarmedSession(conversationId);
    const session = preWarmed ?? new RealtimeVoiceSession();
    console.log(`[VoiceRTC:hook] effect fired — preWarmed=${!!preWarmed} window=${windowType}`);
    sessionRef.current = session;

    const unsubscribe = session.on((event: VoiceSessionEvent) => {
      if (aborted) return;
      if (event.type === "state-change") {
        setSessionState(event.state);
        analyserRef.current = session.getAnalyser();
      }
    });

    if (preWarmed) {
      // Session is already connecting/connected — sync current state
      setSessionState(session.state);
      if (session.state === "connected") {
        analyserRef.current = session.getAnalyser();
      }
    } else {
      // No pre-warm — connect normally
      session.connect(conversationId).catch((err) => {
        if (aborted) return;
        console.error("[useRealtimeVoice] Failed to connect:", err);
        setSessionState("error");
      });
    }

    return () => {
      aborted = true;
      unsubscribe();
      analyserRef.current = null;
      void session.disconnect();
      sessionRef.current = null;
      setSessionState("idle");
    };
  }, [state.isVoiceRtcActive, state.conversationId, state.window, windowType]);

  return {
    analyserRef,
    isConnected: sessionState === "connected",
    sessionState,
  };
}
