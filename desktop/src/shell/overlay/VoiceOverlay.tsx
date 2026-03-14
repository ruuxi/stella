import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useUiState } from "@/context/ui-state";
import { useVoiceRecording } from "@/features/voice/hooks/use-voice-recording";
import { useRealtimeVoice } from "@/features/voice/hooks/use-realtime-voice";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  StellaAnimation,
  type VoiceMode,
} from "@/shell/ascii-creature/StellaAnimation";
import "./voice-overlay.css";

interface VoiceOverlayProps {
  onTranscript: (text: string) => void;
  visible: boolean;
  style?: CSSProperties;
}

export function VoiceOverlay({
  onTranscript,
  visible,
  style,
}: VoiceOverlayProps) {
  const { state, updateState } = useUiState();
  const [showOverlay, setShowOverlay] = useState(false);
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionFrameRef = useRef<number | null>(null);
  const retainedStyleRef = useRef<CSSProperties | undefined>(style);

  const windowType = useWindowType();
  const isActiveWindow =
    windowType === "overlay" || state.window === windowType;

  // STT mode
  const { analyserRef: sttAnalyserRef, isRecording } = useVoiceRecording({
    isActive: isActiveWindow && state.isVoiceActive,
    onTranscript,
  });

  // RTC mode
  const {
    micLevel: rtcMicLevel,
    outputLevel: rtcOutputLevel,
    isConnected,
    isSpeaking,
    isUserSpeaking,
  } = useRealtimeVoice();

  const isAnyVoiceActive =
    isActiveWindow && (state.isVoiceActive || state.isVoiceRtcActive);
  const shouldDisplayOverlay = isAnyVoiceActive || (visible && isActiveWindow);
  const isAudioReady = isRecording || isConnected;

  /* eslint-disable react-hooks/refs -- retainedStyleRef caches latest style prop; always re-derived from props so render-time access is safe */
  if (style) {
    retainedStyleRef.current = style;
  } else if (isAnyVoiceActive) {
    retainedStyleRef.current = undefined;
  }
  /* eslint-enable react-hooks/refs */

  // Voice mode uses server-reported speaking state for RTC (more reliable
  // than energy thresholds which decay slowly due to analyser smoothing).
  let voiceMode: VoiceMode = "idle";
  const micAnalyserRef = sttAnalyserRef;
  let micLevel: number | undefined;
  let outputLevel: number | undefined;

  if (isAudioReady) {
    voiceMode = state.isVoiceRtcActive && isSpeaking ? "speaking" : "listening";
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

    if (shouldDisplayOverlay) {
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
  }, [shouldDisplayOverlay, showOverlay]);

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
      retainedStyleRef.current = undefined;
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

  // eslint-disable-next-line react-hooks/refs -- ref is always synced with style prop during render
  const overlayStyle = style ?? retainedStyleRef.current;

  return (
    <div className="voice-overlay" style={overlayStyle}>
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

