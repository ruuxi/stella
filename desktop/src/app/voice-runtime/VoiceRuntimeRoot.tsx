import { useEffect, useRef, useState } from "react";
import { useUiState } from "@/context/ui-state";
import { getOrCreateDeviceId } from "@/platform/electron/device";
import { appendLocalEvent } from "@/app/chat/services/local-chat-store";
import { type VoiceSessionState } from "@/app/voice/services/realtime-voice";
import { VoiceSessionManager } from "@/app/voice/hooks/use-realtime-voice";

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

let energyBuffer: Uint8Array<ArrayBuffer> | null = null;

const appendEventLocalFallback = async (args: {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
}) => {
  await appendLocalEvent(args);
  return null;
};

const computeEnergy = (analyser: AnalyserNode | null): number => {
  if (!analyser) return 0;
  const len = analyser.frequencyBinCount;
  if (!energyBuffer || energyBuffer.length < len) {
    energyBuffer = new Uint8Array(len);
  }
  analyser.getByteFrequencyData(energyBuffer);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const value = energyBuffer[i] / 255;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, len));
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
  const analyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string>(state.conversationId ?? "voice-rtc");
  const inputActiveRef = useRef<boolean>(state.isVoiceRtcActive);
  const appendEventRef = useRef(appendEventLocalFallback);
  const managerRef = useRef<VoiceSessionManager | null>(null);
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
    void getOrCreateDeviceId().then((deviceId) => {
      deviceIdRef.current = deviceId;
    });
  }, []);

  useEffect(() => {
    if (state.conversationId) {
      setBootConversationId(state.conversationId);
      return;
    }

    if (bootConversationId) {
      return;
    }

    const getDefaultConversationId =
      window.electronAPI?.localChat.getOrCreateDefaultConversationId;
    if (!getDefaultConversationId) {
      setBootConversationId("voice-rtc");
      return;
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
  }, [bootConversationId, state.conversationId]);

  useEffect(() => {
    inputActiveRef.current = state.isVoiceRtcActive;
  }, [state.isVoiceRtcActive]);

  useEffect(() => {
    if (!resolvedConversationId || managerRef.current) {
      return;
    }

    conversationIdRef.current = resolvedConversationId;
    publishRuntimeState(DEFAULT_RUNTIME_STATE);

    const manager = new VoiceSessionManager({
      conversationIdRef,
      inputActiveRef,
      appendEventRef,
      deviceIdRef,
      analyserRef,
      outputAnalyserRef,
      onStateChange: (sessionState) => {
        sessionStateRef.current = sessionState;
        publishRuntimeState({
          sessionState,
          isConnected: sessionState === "connected",
          micLevel: sessionState === "connected" ? publishedStateRef.current.micLevel : 0,
          outputLevel: sessionState === "connected" ? publishedStateRef.current.outputLevel : 0,
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
      publishRuntimeState({
        sessionState: sessionStateRef.current,
        isConnected: sessionStateRef.current === "connected",
        isSpeaking: speakingRef.current,
        isUserSpeaking: userSpeakingRef.current,
        micLevel: computeEnergy(analyserRef.current),
        outputLevel: computeEnergy(outputAnalyserRef.current),
      });
    }, LEVEL_SAMPLE_MS);
  }, [resolvedConversationId]);

  useEffect(() => {
    return () => {
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
