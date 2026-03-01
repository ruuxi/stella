import { useEffect, useRef, useState } from "react";
import {
  RealtimeVoiceSession,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "../services/realtime-voice";
import { useUiState } from "../app/state/ui-state";

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

  useEffect(() => {
    if (!state.isVoiceRtcActive) return;

    // Disconnect any zombie session from a previous StrictMode mount
    if (sessionRef.current) {
      void sessionRef.current.disconnect();
      sessionRef.current = null;
    }

    let aborted = false;
    const session = new RealtimeVoiceSession();
    sessionRef.current = session;

    const unsubscribe = session.on((event: VoiceSessionEvent) => {
      if (aborted) return;
      if (event.type === "state-change") {
        setSessionState(event.state);
        analyserRef.current = session.getAnalyser();
      }
    });

    const conversationId = state.conversationId ?? "voice-rtc";
    session.connect(conversationId).catch((err) => {
      if (aborted) return;
      console.error("[useRealtimeVoice] Failed to connect:", err);
      setSessionState("error");
    });

    return () => {
      aborted = true;
      unsubscribe();
      analyserRef.current = null;
      void session.disconnect();
      sessionRef.current = null;
      setSessionState("idle");
    };
  }, [state.isVoiceRtcActive, state.conversationId]);

  return {
    analyserRef,
    isConnected: sessionState === "connected",
    sessionState,
  };
}
