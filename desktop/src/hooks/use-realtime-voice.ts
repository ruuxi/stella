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

    let aborted = false;
    const session = new RealtimeVoiceSession();
    sessionRef.current = session;

    const unsubscribe = session.on((event: VoiceSessionEvent) => {
      if (aborted) return;
      if (event.type === "state-change") {
        setSessionState(event.state);
        // Update analyser ref once connected
        analyserRef.current = session.getAnalyser();
      }
    });

    const conversationId = state.conversationId ?? "voice-rtc";
    session.connect(conversationId).catch((err) => {
      if (aborted) return;
      console.error("[useRealtimeVoice] Failed to connect:", err);
      setSessionState("error");
    });

    // Poll analyser until available (it's created during connect)
    const pollInterval = setInterval(() => {
      const a = session.getAnalyser();
      if (a) {
        analyserRef.current = a;
        clearInterval(pollInterval);
      }
    }, 100);

    return () => {
      aborted = true;
      clearInterval(pollInterval);
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
