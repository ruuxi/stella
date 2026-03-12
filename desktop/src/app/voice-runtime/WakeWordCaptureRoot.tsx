import { useEffect, useMemo, useState } from "react";
import { useUiState } from "@/context/ui-state";
import {
  TARGET_WAV_SAMPLE_RATE,
  floatToInt16Pcm,
  resampleLinear,
} from "@/app/voice/services/audio-encoding";
import {
  acquireSharedMicrophone,
  bufferRecentVoiceHandoffPcm,
  type SharedMicrophoneLease,
} from "@/app/voice/services/shared-microphone";

const WAKE_WORD_CHUNK_SAMPLES = 1280;
const VOICE_HANDOFF_SAMPLE_RATE = 24_000;

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

export function WakeWordCaptureRoot() {
  const { state } = useUiState();
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);

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

  useEffect(() => {
    if (!shouldCapture) {
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

    const cleanup = () => {
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
        micLease = await acquireSharedMicrophone();
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
          const handoffSamples = resampleLinear(
            samples,
            audioContext.sampleRate,
            VOICE_HANDOFF_SAMPLE_RATE,
          );
          bufferRecentVoiceHandoffPcm(floatToInt16Pcm(handoffSamples));

          const resampled = resampleLinear(
            samples,
            audioContext.sampleRate,
            TARGET_WAV_SAMPLE_RATE,
          );
          flushPcm(floatToInt16Pcm(resampled));
        };

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
  }, [shouldCapture]);

  return null;
}
