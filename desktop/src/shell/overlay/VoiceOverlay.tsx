import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useUiState } from "@/context/ui-state";
import { useRealtimeVoice } from "@/features/voice/hooks/use-realtime-voice";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  StellaAnimation,
  type VoiceMode,
} from "@/shell/ascii-creature/StellaAnimation";
import "./voice-overlay.css";

interface VoiceOverlayProps {
  visible: boolean;
  style?: CSSProperties;
}

export function VoiceOverlay({
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

  // RTC mode
  const {
    micLevel: rtcMicLevel,
    outputLevel: rtcOutputLevel,
    isConnected,
    isSpeaking,
    isUserSpeaking,
  } = useRealtimeVoice();

  const isAnyVoiceActive =
    isActiveWindow && state.isVoiceRtcActive;
  const shouldDisplayOverlay = isAnyVoiceActive || (visible && isActiveWindow);
  const isAudioReady = isConnected;

  /* eslint-disable react-hooks/refs -- retainedStyleRef caches latest style prop; always re-derived from props so render-time access is safe */
  if (style) {
    retainedStyleRef.current = style;
  } else if (isAnyVoiceActive) {
    retainedStyleRef.current = undefined;
  }
  /* eslint-enable react-hooks/refs */

  let voiceMode: VoiceMode = "idle";
  let micLevel: number | undefined;
  let outputLevel: number | undefined;

  if (isAudioReady) {
    voiceMode = isSpeaking ? "speaking" : "listening";
    micLevel = rtcMicLevel;
    outputLevel = rtcOutputLevel;
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
    updateState({ isVoiceRtcActive: false });
  }, [updateState]);

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
          micLevel={micLevel}
          outputLevel={outputLevel}
        />
      </div>
    </div>
  );
}

