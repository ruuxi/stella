import { useEffect, useRef, useState } from "react";
import { useUiState } from "@/context/ui-state";
import { type VoiceSessionState } from "@/features/voice/services/realtime-voice";
import { VoiceSessionManager } from "@/features/voice/hooks/use-realtime-voice";
import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import { computeAnalyserEnergy } from "@/features/voice/services/audio-energy";

type RuntimeVoiceState = {
  sessionState: VoiceSessionState;
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

const LEVEL_SAMPLE_MS = 24;
const DEFAULT_RUNTIME_STATE: RuntimeVoiceState = {
  sessionState: "idle",
  isConnected: false,
  isSpeaking: false,
  isUserSpeaking: false,
  micLevel: 0,
  outputLevel: 0,
};

let energyBuffer: Uint8Array | null = null;

const computeEnergy = (analyser: AnalyserNode | null): number => {
  const result = computeAnalyserEnergy(analyser, energyBuffer);
  energyBuffer = result.buffer;
  return result.energy;
};

const runtimeStateEquals = (a: RuntimeVoiceState, b: RuntimeVoiceState) =>
  a.sessionState === b.sessionState &&
  a.isConnected === b.isConnected &&
  a.isSpeaking === b.isSpeaking &&
  a.isUserSpeaking === b.isUserSpeaking &&
  Math.abs(a.micLevel - b.micLevel) < 0.01 &&
  Math.abs(a.outputLevel - b.outputLevel) < 0.01;

export function VoiceRuntimeRoot() {
  const { state } = useUiState();
  const [bootConversationId, setBootConversationId] = useState<string | null>(
    state.conversationId,
  );
  /**
   * Pre-warm: when the wake word is enabled we keep a Realtime WebRTC
   * session open with the mic gated off (`inputActive=false`). OpenAI
   * Realtime only bills for streamed audio tokens, so an idle
   * connection costs nothing — but it removes the ~1s cold-start cost
   * between "Hey Stella" and Stella starting to listen for real.
   *
   * When voice activates (via wake word, keybind, or the radial
   * wedge), we flip `inputActive=true` and the existing session takes
   * over. When voice ends, we drop back to pre-warm rather than
   * tearing down the connection.
   */
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const sessionShouldRun = state.isVoiceRtcActive || wakeWordEnabled;
  const analyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const conversationIdRef = useRef<string>(state.conversationId ?? "voice-rtc");
  const inputActiveRef = useRef<boolean>(state.isVoiceRtcActive);
  const managerRef = useRef<VoiceSessionManager | null>(null);
  const warmMicLeaseRef = useRef<SharedMicrophoneLease | null>(null);
  const publishedStateRef = useRef<RuntimeVoiceState>(DEFAULT_RUNTIME_STATE);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakingRef = useRef(false);
  const userSpeakingRef = useRef(false);
  const sessionStateRef = useRef<VoiceSessionState>("idle");
  const resolvedConversationId = state.conversationId ?? bootConversationId;

  const publishRuntimeState = (patch: Partial<RuntimeVoiceState>) => {
    const next: RuntimeVoiceState = {
      ...publishedStateRef.current,
      ...patch,
    };
    if (runtimeStateEquals(publishedStateRef.current, next)) {
      return;
    }
    publishedStateRef.current = next;
    window.electronAPI?.voice.pushRuntimeState(next);
  };

  useEffect(() => {
    if (!state.conversationId || state.conversationId === bootConversationId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setBootConversationId(state.conversationId);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [bootConversationId, state.conversationId]);

  useEffect(() => {
    if (!sessionShouldRun || state.conversationId || bootConversationId) {
      return;
    }

    const getDefaultConversationId =
      window.electronAPI?.localChat.getOrCreateDefaultConversationId;
    if (!getDefaultConversationId) {
      const timer = window.setTimeout(() => {
        setBootConversationId("voice-rtc");
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }

    let cancelled = false;
    void getDefaultConversationId()
      .then((conversationId) => {
        if (!cancelled) {
          setBootConversationId(conversationId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBootConversationId("voice-rtc");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bootConversationId, state.conversationId, sessionShouldRun]);

  useEffect(() => {
    inputActiveRef.current = state.isVoiceRtcActive;
  }, [state.isVoiceRtcActive]);

  useEffect(() => {
    let cancelled = false;

    if (!wakeWordEnabled) {
      warmMicLeaseRef.current?.release();
      warmMicLeaseRef.current = null;
      return;
    }

    void acquireSharedMicrophone()
      .then((lease) => {
        if (cancelled || !wakeWordEnabled) {
          lease.release();
          return;
        }
        warmMicLeaseRef.current?.release();
        warmMicLeaseRef.current = lease;
      })
      .catch((error) => {
        console.debug(
          "[voice-runtime] Failed to warm microphone for wake word:",
          (error as Error).message,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [wakeWordEnabled]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.system
      ?.getWakeWordEnabled?.()
      .then((enabled) => {
        if (!cancelled) setWakeWordEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The wake-word IPC isn't broadcast on toggle today — re-read the
  // setting whenever the window regains focus. That's enough to pick
  // up settings-panel changes without adding a dedicated push channel.
  useEffect(() => {
    const refresh = () => {
      void window.electronAPI?.system
        ?.getWakeWordEnabled?.()
        .then(setWakeWordEnabled)
        .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const stopRuntimeSession = () => {
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    managerRef.current?.stop();
    managerRef.current = null;
    speakingRef.current = false;
    userSpeakingRef.current = false;
    sessionStateRef.current = "idle";
    analyserRef.current = null;
    outputAnalyserRef.current = null;
    publishedStateRef.current = DEFAULT_RUNTIME_STATE;
    window.electronAPI?.voice.pushRuntimeState(DEFAULT_RUNTIME_STATE);
  };

  useEffect(() => {
    if (!sessionShouldRun) {
      stopRuntimeSession();
      return;
    }

    if (!resolvedConversationId || managerRef.current) {
      return;
    }

    conversationIdRef.current = resolvedConversationId;
    publishRuntimeState(DEFAULT_RUNTIME_STATE);

    const manager = new VoiceSessionManager({
      conversationIdRef,
      inputActiveRef,
      analyserRef,
      outputAnalyserRef,
      onStateChange: (sessionState) => {
        sessionStateRef.current = sessionState;
        publishRuntimeState({
          sessionState,
          isConnected: sessionState === "connected",
          micLevel:
            sessionState === "connected"
              ? publishedStateRef.current.micLevel
              : 0,
          outputLevel:
            sessionState === "connected"
              ? publishedStateRef.current.outputLevel
              : 0,
        });
      },
      onSpeakingChange: (isSpeaking) => {
        speakingRef.current = isSpeaking;
        publishRuntimeState({ isSpeaking });
      },
      onUserSpeakingChange: (isUserSpeaking) => {
        userSpeakingRef.current = isUserSpeaking;
        publishRuntimeState({ isUserSpeaking });
      },
    });

    managerRef.current = manager;
    manager.start();

    levelTimerRef.current = setInterval(() => {
      analyserRef.current = manager.getAnalyser();
      outputAnalyserRef.current = manager.getOutputAnalyser();

      publishRuntimeState({
        sessionState: sessionStateRef.current,
        isConnected: sessionStateRef.current === "connected",
        isSpeaking: speakingRef.current,
        isUserSpeaking: userSpeakingRef.current,
        micLevel: computeEnergy(analyserRef.current),
        outputLevel: computeEnergy(outputAnalyserRef.current),
      });
    }, LEVEL_SAMPLE_MS);
  }, [resolvedConversationId, sessionShouldRun]);

  useEffect(() => {
    return () => {
      warmMicLeaseRef.current?.release();
      warmMicLeaseRef.current = null;
      stopRuntimeSession();
    };
  }, []);

  useEffect(() => {
    if (!resolvedConversationId) {
      return;
    }

    conversationIdRef.current = resolvedConversationId;
    managerRef.current?.updateSession(
      resolvedConversationId,
      state.isVoiceRtcActive,
    );
  }, [resolvedConversationId, state.isVoiceRtcActive]);

  return null;
}
