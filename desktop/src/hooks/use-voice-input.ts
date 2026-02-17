import { useState, useRef, useCallback, useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceInputState =
  | "idle"
  | "requesting-token"
  | "connecting"
  | "recording"
  | "processing";

type UseVoiceInputOptions = {
  onPartialTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (error: string) => void;
};

type UseVoiceInputReturn = {
  state: VoiceInputState;
  isRecording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 250;
const WISPR_WS_BASE = "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";

// ---------------------------------------------------------------------------
// AudioWorklet processor source (inlined as Blob URL)
// ---------------------------------------------------------------------------

const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.sampleCount = 0;
    this.chunkSize = options?.processorOptions?.chunkSize ?? 12000;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    this.buffer.push(new Float32Array(input));
    this.sampleCount += input.length;

    if (this.sampleCount >= this.chunkSize) {
      const merged = new Float32Array(this.sampleCount);
      let offset = 0;
      for (const chunk of this.buffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.port.postMessage({ type: "pcm-chunk", samples: merged }, [merged.buffer]);
      this.buffer = [];
      this.sampleCount = 0;
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

// ---------------------------------------------------------------------------
// Audio utilities
// ---------------------------------------------------------------------------

/** Downsample float32 audio from source sample rate to 16kHz Int16 PCM. */
function downsample(samples: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const result = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const srcIndex = Math.floor(i * ratio);
    const s = Math.max(-1, Math.min(1, samples[srcIndex]));
    result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return result;
}

/** Encode Int16 PCM samples as a base64 WAV string. */
function encodeWavBase64(samples: Int16Array): string {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = TARGET_SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  // fmt chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const int16View = new Int16Array(buffer, 44);
  int16View.set(samples);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function writeStr(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceInput({
  onPartialTranscript,
  onFinalTranscript,
  onError,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [state, setState] = useState<VoiceInputState>("idle");
  const generateToken = useAction(api.data.stt.generateSttToken);

  // Refs for cleanup
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const packetPositionRef = useRef(0);
  const totalPacketsRef = useRef(0);
  const tokenCacheRef = useRef<{ token: string; expiresAt: number } | null>(null);
  const stateRef = useRef(state);

  // Keep stateRef in sync
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    // Stop audio worklet
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // Stop media stream tracks
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    // Close audio context
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    packetPositionRef.current = 0;
    totalPacketsRef.current = 0;
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    // Return cached token if still valid (with 30s buffer)
    const cached = tokenCacheRef.current;
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.token;
    }

    const result = await generateToken({ durationSecs: 300 });
    if (result.error || !result.token) {
      onError(result.error ?? "Failed to get STT token");
      return null;
    }

    tokenCacheRef.current = {
      token: result.token,
      expiresAt: result.expiresAt ?? Date.now() + 280_000,
    };
    return result.token;
  }, [generateToken, onError]);

  const startRecording = useCallback(async () => {
    if (stateRef.current !== "idle") return;

    try {
      // Step 1: Get token
      setState("requesting-token");
      const token = await getToken();
      if (!token) {
        setState("idle");
        return;
      }

      // Step 2: Connect WebSocket
      setState("connecting");
      const wsUrl = `${WISPR_WS_BASE}?client_key=${encodeURIComponent(`Bearer ${token}`)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10_000);

        ws.onopen = () => {
          clearTimeout(timeout);
          // Send auth message
          ws.send(
            JSON.stringify({
              type: "auth",
              access_token: token,
              language: ["en"],
              context: {},
            }),
          );
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.status === "auth") {
              resolve();
            }
          } catch {
            // Ignore non-JSON messages during auth
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        };

        ws.onclose = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket closed during connection"));
        };
      });

      // Set up message handler for transcriptions
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.status === "text" && msg.body?.text) {
            if (msg.final) {
              onFinalTranscript(msg.body.text);
              setState("idle");
              cleanup();
            } else {
              onPartialTranscript(msg.body.text);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        onError("WebSocket error during recording");
        setState("idle");
        cleanup();
      };

      ws.onclose = () => {
        if (stateRef.current === "recording" || stateRef.current === "processing") {
          // Unexpected close
          setState("idle");
          cleanup();
        }
      };

      // Step 3: Start microphone capture
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: 48000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const nativeSampleRate = audioCtx.sampleRate;

      // Calculate chunk size for ~250ms at native sample rate
      const chunkSize = Math.floor(nativeSampleRate * (CHUNK_DURATION_MS / 1000));

      // Register worklet from Blob URL
      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor", {
        processorOptions: { chunkSize },
      });
      workletNodeRef.current = workletNode;

      // Handle PCM chunks from worklet
      packetPositionRef.current = 0;
      totalPacketsRef.current = 0;

      workletNode.port.onmessage = (e) => {
        if (e.data.type !== "pcm-chunk") return;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const pcmFloat = e.data.samples as Float32Array;
        const pcm16 = downsample(pcmFloat, nativeSampleRate);
        const wavBase64 = encodeWavBase64(pcm16);

        // Compute volume (RMS) for the packet
        let sum = 0;
        for (let i = 0; i < pcmFloat.length; i++) {
          sum += pcmFloat[i] * pcmFloat[i];
        }
        const volume = Math.sqrt(sum / pcmFloat.length);

        wsRef.current.send(
          JSON.stringify({
            type: "append",
            position: packetPositionRef.current,
            audio_packets: {
              packets: [wavBase64],
              volumes: [Math.min(1, volume)],
              packet_duration: CHUNK_DURATION_MS / 1000,
              audio_encoding: "wav",
              byte_encoding: "base64",
            },
          }),
        );

        packetPositionRef.current++;
        totalPacketsRef.current++;
      };

      // Connect audio graph: mic → worklet
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(workletNode);
      // Don't connect worklet to destination (no playback)

      setState("recording");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Recording failed";
      if (message.includes("Permission denied") || message.includes("NotAllowedError")) {
        onError("Microphone access denied");
      } else {
        onError(message);
      }
      setState("idle");
      cleanup();
    }
  }, [getToken, onPartialTranscript, onFinalTranscript, onError, cleanup]);

  const stopRecording = useCallback(() => {
    if (stateRef.current !== "recording") return;

    setState("processing");

    // Stop the audio worklet and stream (stop sending audio)
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    // Send commit to Wispr to get final transcription
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "commit",
          total_packets: totalPacketsRef.current,
        }),
      );

      // Timeout: if no final transcript in 10s, give up
      setTimeout(() => {
        if (stateRef.current === "processing") {
          setState("idle");
          cleanup();
        }
      }, 10_000);
    } else {
      setState("idle");
      cleanup();
    }
  }, [cleanup]);

  return {
    state,
    isRecording: state === "recording",
    startRecording,
    stopRecording,
  };
}
