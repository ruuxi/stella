import { useEffect, useMemo, useRef, useState } from "react";
import { useUiState } from "@/context/ui-state";
import {
  floatToInt16Pcm,
  resampleLinear,
} from "@/features/voice/services/audio-encoding";
import {
  createStreamingSession,
  type StreamingTranscribeSession,
} from "@/features/voice/services/speech-to-text";
import {
  acquireSharedMicrophone,
  type SharedMicrophoneLease,
} from "@/features/voice/services/shared-microphone";
import {
  normalizeWakeWordHandoffText,
  publishWakeWordHandoffPrefill,
} from "@/features/voice/services/wake-word-handoff";

const WAKE_WORD_SAMPLE_RATE = 16_000;
const WAKE_WORD_CHUNK_SAMPLES = 1280;
const WAKE_WORD_MIC_USE_CASE = "wake-word" as const;
const WAKE_WORD_HANDOFF_RECENT_SAMPLES = WAKE_WORD_SAMPLE_RATE * 2;
const WAKE_WORD_HANDOFF_CAPTURE_MS = 1_200;
const WAKE_WORD_HANDOFF_PROMPT =
  'The wake word is "Stella". Transcribe only the user speech after the wake word. If the clip only contains the wake word or silence, return an empty transcript.';

const combinePcm = (left: Int16Array, right: Int16Array): Int16Array => {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }

  const merged = new Int16Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
};

const copyChunk = (chunk: Float32Array): Float32Array => {
  const copy = new Float32Array(chunk.length);
  copy.set(chunk);
  return copy;
};

export function WakeWordCaptureRoot() {
  const { state } = useUiState();
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [handoffCaptureActive, setHandoffCaptureActive] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.voice;
    if (!api) {
      return;
    }

    let cancelled = false;
    void api
      .getWakeWordState()
      .then((nextState) => {
        if (!cancelled) {
          setWakeWordEnabled(Boolean(nextState?.enabled));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWakeWordEnabled(false);
        }
      });

    const unsubscribe = api.onWakeWordState((nextState) => {
      setWakeWordEnabled(Boolean(nextState?.enabled));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const shouldCapture = useMemo(
    () => wakeWordEnabled && !state.isVoiceActive && !state.isVoiceRtcActive,
    [state.isVoiceActive, state.isVoiceRtcActive, wakeWordEnabled],
  );
  const shouldRunCapture = shouldCapture || handoffCaptureActive;
  const shouldCaptureRef = useRef(shouldCapture);

  useEffect(() => {
    shouldCaptureRef.current = shouldCapture;
  }, [shouldCapture]);

  useEffect(() => {
    if (!shouldRunCapture) {
      return;
    }

    const api = window.electronAPI?.voice;
    if (!api) {
      return;
    }

    let stopped = false;
    let micLease: SharedMicrophoneLease | null = null;
    let audioContext: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let workletNode: AudioWorkletNode | null = null;
    let silentSink: GainNode | null = null;
    let remainder = new Int16Array(0);
    let handoffSession: StreamingTranscribeSession | null = null;
    let handoffTimer: ReturnType<typeof window.setTimeout> | null = null;
    let unsubscribeWakeWordDetected: (() => void) | null = null;
    const recentChunks: Float32Array[] = [];
    let recentChunkSamples = 0;

    const clearRecentChunks = () => {
      recentChunks.length = 0;
      recentChunkSamples = 0;
    };

    const appendRecentChunk = (chunk: Float32Array) => {
      const storedChunk = copyChunk(chunk);
      recentChunks.push(storedChunk);
      recentChunkSamples += storedChunk.length;

      while (
        recentChunkSamples > WAKE_WORD_HANDOFF_RECENT_SAMPLES &&
        recentChunks.length > 1
      ) {
        const removed = recentChunks.shift();
        recentChunkSamples -= removed?.length ?? 0;
      }
    };

    const finalizeHandoffCapture = () => {
      if (handoffTimer) {
        window.clearTimeout(handoffTimer);
        handoffTimer = null;
      }

      const session = handoffSession;
      handoffSession = null;
      setHandoffCaptureActive(false);

      if (!session) {
        return;
      }

      const prefillPromise = session
        .commit()
        .then((result) => normalizeWakeWordHandoffText(result.text))
        .catch(() => null);
      publishWakeWordHandoffPrefill(prefillPromise);
    };

    const startHandoffCapture = () => {
      if (handoffSession) {
        return;
      }

      handoffSession = createStreamingSession({
        properties: {
          prompt: WAKE_WORD_HANDOFF_PROMPT,
        },
      });

      setHandoffCaptureActive(true);
      for (const chunk of recentChunks) {
        handoffSession.sendChunk(chunk, WAKE_WORD_SAMPLE_RATE);
      }

      handoffTimer = window.setTimeout(() => {
        finalizeHandoffCapture();
      }, WAKE_WORD_HANDOFF_CAPTURE_MS);
    };

    const cleanup = () => {
      unsubscribeWakeWordDetected?.();
      unsubscribeWakeWordDetected = null;
      if (handoffTimer) {
        window.clearTimeout(handoffTimer);
        handoffTimer = null;
      }
      if (handoffSession) {
        handoffSession.abort();
        handoffSession = null;
      }
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
        workletNode = null;
      }
      if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
      }
      if (silentSink) {
        silentSink.disconnect();
        silentSink = null;
      }
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
      if (micLease) {
        micLease.release();
        micLease = null;
      }
      remainder = new Int16Array(0);
      clearRecentChunks();
    };

    const flushPcm = (pcm: Int16Array) => {
      let buffered = combinePcm(remainder, pcm);
      let offset = 0;

      while (offset + WAKE_WORD_CHUNK_SAMPLES <= buffered.length) {
        const chunk = buffered.slice(offset, offset + WAKE_WORD_CHUNK_SAMPLES);
        offset += WAKE_WORD_CHUNK_SAMPLES;
        api.pushWakeWordAudio(
          chunk.buffer.slice(
            chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength,
          ),
        );
      }

      remainder =
        offset < buffered.length ? buffered.slice(offset) : new Int16Array(0);
      buffered = new Int16Array(0);
    };

    void (async () => {
      try {
        micLease = await acquireSharedMicrophone({
          useCase: WAKE_WORD_MIC_USE_CASE,
        });
        if (stopped) {
          cleanup();
          return;
        }

        audioContext = new AudioContext();
        const resumePromise =
          audioContext.state === "suspended"
            ? audioContext.resume()
            : Promise.resolve();
        const workletModulePromise = audioContext.audioWorklet.addModule(
          "/audio-capture-processor.js",
        );

        await Promise.all([resumePromise, workletModulePromise]);
        if (stopped || !audioContext) {
          cleanup();
          return;
        }

        sourceNode = audioContext.createMediaStreamSource(micLease.stream);
        workletNode = new AudioWorkletNode(
          audioContext,
          "audio-capture-processor",
        );
        silentSink = audioContext.createGain();
        silentSink.gain.value = 0;

        workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (stopped || !audioContext) {
            return;
          }
          const samples = event.data;
          if (!samples || samples.length === 0) {
            return;
          }
          const resampled = resampleLinear(
            samples,
            audioContext.sampleRate,
            WAKE_WORD_SAMPLE_RATE,
          );
          appendRecentChunk(resampled);
          handoffSession?.sendChunk(resampled, WAKE_WORD_SAMPLE_RATE);
          if (shouldCaptureRef.current) {
            flushPcm(floatToInt16Pcm(resampled));
          }
        };

        unsubscribeWakeWordDetected = api.onWakeWordDetected(() => {
          if (stopped) {
            return;
          }
          startHandoffCapture();
        });

        sourceNode.connect(workletNode);
        workletNode.connect(silentSink);
        silentSink.connect(audioContext.destination);
      } catch (error) {
        console.debug(
          "[wake-word] Failed to start renderer wake-word capture:",
          (error as Error).message,
        );
        cleanup();
      }
    })();

    return () => {
      stopped = true;
      cleanup();
    };
  }, [shouldRunCapture]);

  return null;
}
