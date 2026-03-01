import { useEffect, useRef, useState } from "react";
import {
  createStreamingSession,
  type StreamingTranscribeSession,
} from "../services/speech-to-text";

interface UseVoiceRecordingOptions {
  isActive: boolean;
  onTranscript: (text: string) => void;
}

interface UseVoiceRecordingResult {
  analyserRef: React.RefObject<AnalyserNode | null>;
  isRecording: boolean;
  isTranscribing: boolean;
}

const MAX_RECORDING_MS = 5 * 60 * 1000;

export function useVoiceRecording({
  isActive,
  onTranscript,
}: UseVoiceRecordingOptions): UseVoiceRecordingResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Refs to hold session across the effect boundary so cleanup can commit
  const sessionRef = useRef<StreamingTranscribeSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const maxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isActive) return;

    let stopped = false;

    const cleanupAudio = () => {
      if (maxTimeoutRef.current) {
        clearTimeout(maxTimeoutRef.current);
        maxTimeoutRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      analyserRef.current = null;
    };

    const commitAndFinish = () => {
      cleanupAudio();
      setIsRecording(false);
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;

      setIsTranscribing(true);
      session
        .commit()
        .then((result) => {
          if (result.text?.trim()) {
            onTranscriptRef.current(result.text.trim());
          }
        })
        .catch((err: unknown) =>
          console.error("Transcription failed:", err),
        )
        .finally(() => setIsTranscribing(false));
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const ctx = new AudioContext();
        audioContextRef.current = ctx;

        // Ensure context is running (browsers may start it suspended)
        if (ctx.state === "suspended") await ctx.resume();
        if (stopped) {
          ctx.close();
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const source = ctx.createMediaStreamSource(stream);

        // Analyser for waveform visualization
        const analyser = ctx.createAnalyser();
        analyserRef.current = analyser;
        analyser.fftSize = 256;
        source.connect(analyser);

        // Streaming session — pre-warms WS + auth while we start capturing
        const session = createStreamingSession();
        sessionRef.current = session;

        // AudioWorklet streams raw PCM chunks to the session
        await ctx.audioWorklet.addModule("/audio-capture-processor.js");
        const workletNode = new AudioWorkletNode(ctx, "audio-capture-processor");
        workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
          if (stopped) return;
          session.sendChunk(e.data, ctx.sampleRate);
        };
        source.connect(workletNode);
        workletNode.connect(ctx.destination);

        if (!stopped) setIsRecording(true);

        maxTimeoutRef.current = setTimeout(commitAndFinish, MAX_RECORDING_MS);
      } catch (err) {
        console.error("Failed to start recording:", err);
      }
    })();

    return () => {
      stopped = true;
      commitAndFinish();
    };
  }, [isActive]);

  return { analyserRef, isRecording, isTranscribing };
}
