import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useUiState } from "@/providers/ui-state";
import { useVoiceRecording } from "@/hooks/use-voice-recording";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { useWindowType } from "@/hooks/use-window-type";
import { StellaAnimation, type VoiceMode } from "@/app/shell/ascii-creature/StellaAnimation";
import "./voice-overlay.css";

interface VoiceOverlayProps {
  onTranscript: (text: string) => void;
  style?: CSSProperties;
}

export function VoiceOverlay({ onTranscript, style }: VoiceOverlayProps) {
  const { state, updateState } = useUiState();
  const [showOverlay, setShowOverlay] = useState(false);
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionFrameRef = useRef<number | null>(null);

  const windowType = useWindowType();
  const isActiveWindow = windowType === "overlay" || state.window === windowType;

  // STT mode
  const { analyserRef: sttAnalyserRef, isRecording } = useVoiceRecording({
    isActive: isActiveWindow && state.isVoiceActive,
    onTranscript,
  });

  // RTC mode
  const { micLevel: rtcMicLevel, outputLevel: rtcOutputLevel, isConnected, isUserSpeaking } = useRealtimeVoice();

  const isAnyVoiceActive = isActiveWindow && (state.isVoiceActive || state.isVoiceRtcActive);
  const isAudioReady = isRecording || isConnected;

  // Determine voice mode — the animation loop auto-detects speaking vs listening
  // from the audio analysers, so we just signal "listening" (= voice session active).
  let voiceMode: VoiceMode = "idle";
  let micAnalyserRef = sttAnalyserRef;
  let micLevel: number | undefined;
  let outputLevel: number | undefined;

  if (isAudioReady) {
    voiceMode = "listening";
    if (state.isVoiceRtcActive) {
      micLevel = rtcMicLevel;
      outputLevel = rtcOutputLevel;
    }
  }

  // Show/hide with exit animation
  useEffect(() => {
    if (transitionFrameRef.current) {
      cancelAnimationFrame(transitionFrameRef.current);
      transitionFrameRef.current = null;
    }

    if (isAnyVoiceActive) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      transitionFrameRef.current = requestAnimationFrame(() => {
        transitionFrameRef.current = null;
        setExiting(false);
        setShowOverlay(true);
      });
      return;
    }

    if (!showOverlay || exitTimerRef.current) {
      return;
    }

    transitionFrameRef.current = requestAnimationFrame(() => {
      transitionFrameRef.current = null;
      setExiting(true);
    });
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setShowOverlay(false);
      setExiting(false);
    }, 250);
  }, [isAnyVoiceActive, showOverlay]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      if (transitionFrameRef.current) {
        cancelAnimationFrame(transitionFrameRef.current);
        transitionFrameRef.current = null;
      }
    };
  }, []);

  const handleClick = useCallback(() => {
    if (state.isVoiceRtcActive) {
      updateState({ isVoiceRtcActive: false });
    } else {
      updateState({ isVoiceActive: false });
    }
  }, [state.isVoiceRtcActive, updateState]);

  if (!showOverlay) return null;

  return (
    <div className="voice-overlay" style={style}>
      <div
        className={`voice-overlay-creature${exiting ? " voice-overlay-exiting" : ""}`}
        onClick={handleClick}
      >
        <StellaAnimation
          width={20}
          height={20}
          maxDpr={2}
          voiceMode={voiceMode}
          isUserSpeaking={isUserSpeaking}
          analyserRef={micAnalyserRef}
          micLevel={micLevel}
          outputLevel={outputLevel}
        />
      </div>
    </div>
  );
}
