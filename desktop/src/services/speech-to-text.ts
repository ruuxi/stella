import { createServiceRequest } from "./http/service-request";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_RESPONSE_TIMEOUT_MS = 45_000;
const WS_FINALIZATION_GRACE_MS = 300;
const WS_AUTH_ACK_FALLBACK_MS = 750;
const TARGET_WAV_SAMPLE_RATE = 16_000;
const PACKET_DURATION_SECONDS = 1;
const PACKETS_PER_APPEND = 10;
const SAMPLES_PER_PACKET = TARGET_WAV_SAMPLE_RATE * PACKET_DURATION_SECONDS;

export type SpeechToTextContext = Record<string, unknown>;

export type SpeechToTextRequest = {
  audio: Blob;
  language?: string[];
  context?: SpeechToTextContext;
  properties?: Record<string, unknown>;
};

export type SpeechToTextResult = {
  id: string | null;
  text: string;
  detectedLanguage: string | null;
  totalTime: number | null;
  generatedTokens: number | null;
};

type SpeechToTextWsTokenResponse = {
  clientKey?: unknown;
  websocketUrl?: unknown;
};

type SpeechToTextWsResponse = {
  status?: unknown;
  final?: unknown;
  body?: unknown;
  message?: unknown;
  error?: unknown;
};

type SpeechToTextWsTextBody = {
  text?: unknown;
  detected_language?: unknown;
};

type SpeechToTextWsInfoBody = {
  event?: unknown;
};

type PreparedWisprAudio = {
  packetDurationSeconds: number;
  packets: string[];
  volumes: number[];
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read audio blob"));
    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("Failed to encode audio blob"));
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(blob);
  });
};

const arrayBufferToBase64 = (buffer: ArrayBufferLike): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
};

const mixAudioBufferToMono = (audioBuffer: AudioBuffer): Float32Array => {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += channelData[i] ?? 0;
    }
  }

  for (let i = 0; i < length; i += 1) {
    mono[i] /= channelCount;
  }

  return mono;
};

const resampleLinear = (
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array => {
  if (sourceRate === targetRate) return samples;

  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(samples.length / ratio));
  const resampled = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i += 1) {
    const sourceIndex = i * ratio;
    const sourceFloor = Math.floor(sourceIndex);
    const sourceCeil = Math.min(sourceFloor + 1, samples.length - 1);
    const alpha = sourceIndex - sourceFloor;
    const a = samples[sourceFloor] ?? 0;
    const b = samples[sourceCeil] ?? 0;
    resampled[i] = a + (b - a) * alpha;
  }

  return resampled;
};

const floatToInt16Pcm = (samples: Float32Array): Int16Array => {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
};

const calculatePacketVolume = (packetSamples: Float32Array): number => {
  if (packetSamples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < packetSamples.length; i += 1) {
    const sample = packetSamples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / packetSamples.length);
};

const encodeInt16PacketToBase64 = (packet: Int16Array): string => {
  return arrayBufferToBase64(packet.buffer.slice(
    packet.byteOffset,
    packet.byteOffset + packet.byteLength,
  ));
};

const packetizeAudioSamples = (samples: Float32Array): PreparedWisprAudio => {
  const packetCount = Math.max(1, Math.ceil(samples.length / SAMPLES_PER_PACKET));
  const packets: string[] = [];
  const volumes: number[] = [];

  for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
    const start = packetIndex * SAMPLES_PER_PACKET;
    const end = Math.min(start + SAMPLES_PER_PACKET, samples.length);

    const packetFloats = new Float32Array(SAMPLES_PER_PACKET);
    if (end > start) {
      packetFloats.set(samples.subarray(start, end));
    }

    const packetPcm = floatToInt16Pcm(packetFloats);
    packets.push(encodeInt16PacketToBase64(packetPcm));
    volumes.push(calculatePacketVolume(packetFloats));
  }

  return {
    packetDurationSeconds: PACKET_DURATION_SECONDS,
    packets,
    volumes,
  };
};

const prepareAudioForWispr = async (audioBlob: Blob): Promise<PreparedWisprAudio> => {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;

  if (!AudioContextCtor) {
    return {
      packetDurationSeconds: PACKET_DURATION_SECONDS,
      packets: [await blobToBase64(audioBlob)],
      volumes: [0],
    };
  }

  let audioContext: AudioContext | null = null;
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    audioContext = new AudioContextCtor();
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = mixAudioBufferToMono(decoded);
    const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_WAV_SAMPLE_RATE);
    return packetizeAudioSamples(resampled);
  } catch {
    return {
      packetDurationSeconds: PACKET_DURATION_SECONDS,
      packets: [await blobToBase64(audioBlob)],
      volumes: [0],
    };
  } finally {
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // Ignore close errors; we already have encoded packets or fallback packets.
      }
    }
  }
};

const normalizeLanguageCodes = (language: string[] | undefined): string[] | undefined => {
  if (!Array.isArray(language)) return undefined;
  const normalized = language.map((code) => code.trim()).filter((code) => code.length > 0);
  return normalized.length > 0 ? normalized : undefined;
};

const resolveSpeechToTextWsConfig = async (durationSecs?: number) => {
  const { endpoint, headers } = await createServiceRequest("/api/speech-to-text/ws-token", {
    "Content-Type": "application/json",
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(durationSecs != null ? { durationSecs } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Speech websocket token failed: ${response.status} - ${errorText}`);
  }

  const json = (await response.json()) as SpeechToTextWsTokenResponse;
  if (typeof json.clientKey !== "string" || json.clientKey.trim().length === 0) {
    throw new Error("Speech websocket token response missing clientKey");
  }
  if (typeof json.websocketUrl !== "string" || json.websocketUrl.trim().length === 0) {
    throw new Error("Speech websocket token response missing websocketUrl");
  }

  return {
    clientKey: json.clientKey,
    websocketUrl: json.websocketUrl,
  };
};

const buildSpeechToTextSocketUrl = (websocketUrl: string, clientKey: string): string => {
  const socketUrl = new URL(websocketUrl);
  socketUrl.searchParams.set("client_key", `Bearer ${clientKey}`);
  return socketUrl.toString();
};

export async function transcribeAudio(
  input: SpeechToTextRequest,
): Promise<SpeechToTextResult> {
  if (!(input.audio instanceof Blob) || input.audio.size === 0) {
    throw new Error("audio blob is required");
  }
  if (input.audio.size > MAX_AUDIO_BYTES) {
    throw new Error(`audio exceeds ${MAX_AUDIO_BYTES} byte limit`);
  }

  const [preparedAudio, wsConfig] = await Promise.all([
    prepareAudioForWispr(input.audio),
    resolveSpeechToTextWsConfig(),
  ]);

  const language = normalizeLanguageCodes(input.language);
  const socketUrl = buildSpeechToTextSocketUrl(wsConfig.websocketUrl, wsConfig.clientKey);

  return await new Promise<SpeechToTextResult>((resolve, reject) => {
    const ws = new WebSocket(socketUrl);
    let settled = false;
    let didSendAudio = false;
    let commitAcknowledged = false;
    let lastText: string | null = null;
    let detectedLanguage: string | null = null;

    const connectTimeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("Speech websocket connection timed out"));
    }, WS_CONNECT_TIMEOUT_MS);

    let responseTimeout: number | null = null;
    let settleAfterTextTimeout: number | null = null;
    let authFallbackTimeout: number | null = null;

    const clearTimers = () => {
      clearTimeout(connectTimeout);
      if (responseTimeout !== null) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
      }
      if (settleAfterTextTimeout !== null) {
        clearTimeout(settleAfterTextTimeout);
        settleAfterTextTimeout = null;
      }
      if (authFallbackTimeout !== null) {
        clearTimeout(authFallbackTimeout);
        authFallbackTimeout = null;
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      ws.close();
      reject(error);
    };

    const succeed = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimers();
      ws.close();
      resolve({
        id: null,
        text,
        detectedLanguage,
        totalTime: null,
        generatedTokens: null,
      });
    };

    const scheduleSettleFromLatestText = () => {
      if (settled || !lastText || lastText.trim().length === 0) return;
      if (settleAfterTextTimeout !== null) {
        clearTimeout(settleAfterTextTimeout);
      }
      settleAfterTextTimeout = window.setTimeout(() => {
        if (lastText && lastText.trim().length > 0) {
          succeed(lastText);
        }
      }, WS_FINALIZATION_GRACE_MS);
    };

    const sendAudioAndCommit = () => {
      if (didSendAudio || ws.readyState !== WebSocket.OPEN) return;
      didSendAudio = true;

      const totalPackets = preparedAudio.packets.length;
      for (let position = 0; position < totalPackets; position += PACKETS_PER_APPEND) {
        const packetBatch = preparedAudio.packets.slice(position, position + PACKETS_PER_APPEND);
        const volumeBatch = preparedAudio.volumes.slice(position, position + PACKETS_PER_APPEND);

        ws.send(
          JSON.stringify({
            type: "append",
            position,
            audio_packets: {
              packets: packetBatch,
              volumes: volumeBatch,
              packet_duration: preparedAudio.packetDurationSeconds,
              audio_encoding: "wav",
              byte_encoding: "base64",
            },
          }),
        );
      }

      ws.send(
        JSON.stringify({
          type: "commit",
          total_packets: totalPackets,
        }),
      );
    };

    ws.onerror = () => {
      fail(new Error("Speech websocket connection failed"));
    };

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      responseTimeout = window.setTimeout(() => {
        fail(new Error("Speech websocket response timed out"));
      }, WS_RESPONSE_TIMEOUT_MS);

      const authPayload: Record<string, unknown> = {
        type: "auth",
        access_token: wsConfig.clientKey,
      };

      if (language) {
        authPayload.language = language;
      }
      if (input.context) {
        authPayload.context = input.context;
      }
      if (input.properties) {
        authPayload.properties = input.properties;
      }

      ws.send(JSON.stringify(authPayload));

      authFallbackTimeout = window.setTimeout(() => {
        sendAudioAndCommit();
      }, WS_AUTH_ACK_FALLBACK_MS);
    };

    ws.onmessage = (event) => {
      if (settled || typeof event.data !== "string") return;

      let message: SpeechToTextWsResponse;
      try {
        message = JSON.parse(event.data) as SpeechToTextWsResponse;
      } catch {
        return;
      }

      const status = typeof message.status === "string" ? message.status : null;

      if (status === "error") {
        const detail =
          typeof message.error === "string"
            ? message.error
            : message.body && typeof message.body === "object"
              ? JSON.stringify(message.body)
              : "Unknown websocket error";
        fail(new Error(`Speech websocket error: ${detail}`));
        return;
      }

      if (status === "auth") {
        sendAudioAndCommit();
        return;
      }

      if (status === "info") {
        const info = message.message as SpeechToTextWsInfoBody | null | undefined;
        const eventName = typeof info?.event === "string" ? info.event : "";
        if (eventName === "session_started") {
          sendAudioAndCommit();
          return;
        }
        if (eventName === "commit_received") {
          commitAcknowledged = true;
          scheduleSettleFromLatestText();
        }
        return;
      }

      if (status !== "text") {
        return;
      }

      const body = message.body as SpeechToTextWsTextBody | null | undefined;
      if (!body || typeof body.text !== "string") {
        return;
      }

      lastText = body.text;
      if (typeof body.detected_language === "string") {
        detectedLanguage = body.detected_language;
      }

      if (message.final === true) {
        succeed(body.text);
        return;
      }

      if (commitAcknowledged) {
        scheduleSettleFromLatestText();
      }
    };

    ws.onclose = () => {
      if (settled) return;
      if (lastText && lastText.trim().length > 0) {
        succeed(lastText);
        return;
      }
      fail(new Error("Speech websocket closed before receiving transcription text"));
    };
  });
}

// ---------------------------------------------------------------------------
// Streaming API — sends audio chunks in real-time while recording
// ---------------------------------------------------------------------------

export interface StreamingTranscribeSession {
  /** Send a chunk of raw mono float32 samples at the source sample rate. */
  sendChunk(samples: Float32Array, sampleRate: number): void;
  /** Stop streaming, send commit, and return the final transcript. */
  commit(): Promise<SpeechToTextResult>;
  /** Cancel the session without waiting for a result. */
  abort(): void;
}

export function createStreamingSession(options?: {
  language?: string[];
  context?: SpeechToTextContext;
}): StreamingTranscribeSession {
  let phase: "connecting" | "ready" | "committed" | "done" | "error" =
    "connecting";
  let ws: WebSocket | null = null;
  let packetPos = 0;
  let settled = false;
  let lastText: string | null = null;
  let detectedLanguage: string | null = null;
  const buffer: Array<{ b64: string; vol: number; dur: number }> = [];

  // Commit promise hooks
  let onResult: ((r: SpeechToTextResult) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;

  // Ready-state promise
  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  const makeResult = (text: string): SpeechToTextResult => ({
    id: null,
    text,
    detectedLanguage,
    totalTime: null,
    generatedTokens: null,
  });

  const settle = (result: SpeechToTextResult) => {
    if (settled) return;
    settled = true;
    phase = "done";
    ws?.close();
    onResult?.(result);
  };

  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    phase = "error";
    ws?.close();
    onError?.(err);
  };

  const sendAppend = (b64: string, vol: number, dur: number) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "append",
        position: packetPos,
        audio_packets: {
          packets: [b64],
          volumes: [vol],
          packet_duration: dur,
          audio_encoding: "wav",
          byte_encoding: "base64",
        },
      }),
    );
    packetPos++;
  };

  const flushBuffer = () => {
    for (const chunk of buffer) sendAppend(chunk.b64, chunk.vol, chunk.dur);
    buffer.length = 0;
  };

  const becomeReady = () => {
    if (phase !== "connecting") return;
    phase = "ready";
    flushBuffer();
    readyResolve?.();
  };

  // Async setup: fetch token → open WS → authenticate
  void (async () => {
    try {
      const wsConfig = await resolveSpeechToTextWsConfig(360);
      if (phase === "done" || phase === "error") return;

      const socketUrl = buildSpeechToTextSocketUrl(
        wsConfig.websocketUrl,
        wsConfig.clientKey,
      );
      ws = new WebSocket(socketUrl);

      const connectTimeout = window.setTimeout(() => {
        const err = new Error("Speech websocket connection timed out");
        readyReject?.(err);
        fail(err);
      }, WS_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        const authPayload: Record<string, unknown> = {
          type: "auth",
          access_token: wsConfig.clientKey,
        };
        if (options?.language) authPayload.language = options.language;
        if (options?.context) authPayload.context = options.context;
        ws!.send(JSON.stringify(authPayload));

        // Fallback if server never acks auth
        window.setTimeout(becomeReady, WS_AUTH_ACK_FALLBACK_MS);
      };

      ws.onmessage = (event) => {
        if (settled || typeof event.data !== "string") return;

        let msg: SpeechToTextWsResponse;
        try {
          msg = JSON.parse(event.data) as SpeechToTextWsResponse;
        } catch {
          return;
        }

        const status =
          typeof msg.status === "string" ? msg.status : null;

        if (status === "error") {
          const detail =
            typeof msg.error === "string"
              ? msg.error
              : msg.body && typeof msg.body === "object"
                ? JSON.stringify(msg.body)
                : "Unknown websocket error";
          fail(new Error(`Speech websocket error: ${detail}`));
          return;
        }

        if (status === "auth") {
          becomeReady();
          return;
        }

        if (status === "info") {
          const info = msg.message as SpeechToTextWsInfoBody | null | undefined;
          const eventName = typeof info?.event === "string" ? info.event : "";
          if (eventName === "session_started") becomeReady();
          if (eventName === "commit_received" && lastText?.trim()) {
            window.setTimeout(() => {
              if (lastText?.trim()) settle(makeResult(lastText));
            }, WS_FINALIZATION_GRACE_MS);
          }
          return;
        }

        if (status !== "text") return;

        const body = msg.body as SpeechToTextWsTextBody | null | undefined;
        if (!body || typeof body.text !== "string") return;

        lastText = body.text;
        if (typeof body.detected_language === "string") {
          detectedLanguage = body.detected_language;
        }
        if (msg.final === true) {
          settle(makeResult(body.text));
        }
      };

      ws.onerror = () => {
        const err = new Error("Speech websocket connection failed");
        readyReject?.(err);
        fail(err);
      };

      ws.onclose = () => {
        clearTimeout(connectTimeout);
        if (phase === "connecting") {
          const err = new Error("Speech websocket closed before ready");
          readyReject?.(err);
          fail(err);
        } else if (!settled) {
          if (lastText?.trim()) {
            settle(makeResult(lastText));
          } else {
            fail(new Error("Speech websocket closed before transcription"));
          }
        }
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      readyReject?.(error);
      fail(error);
    }
  })();

  return {
    sendChunk(samples: Float32Array, sampleRate: number) {
      if (settled || phase === "committed" || phase === "done" || phase === "error") return;

      const resampled = resampleLinear(samples, sampleRate, TARGET_WAV_SAMPLE_RATE);
      const pcm = floatToInt16Pcm(resampled);
      const b64 = encodeInt16PacketToBase64(pcm);
      const vol = calculatePacketVolume(resampled);
      const dur = resampled.length / TARGET_WAV_SAMPLE_RATE;

      if (phase === "ready") {
        sendAppend(b64, vol, dur);
      } else {
        buffer.push({ b64, vol, dur });
      }
    },

    async commit(): Promise<SpeechToTextResult> {
      if (phase === "error") throw new Error("Session failed");
      if (settled) throw new Error("Session already settled");

      if (phase === "connecting") await readyPromise;

      return new Promise<SpeechToTextResult>((resolve, reject) => {
        onResult = resolve;
        onError = reject;
        phase = "committed";

        ws?.send(JSON.stringify({ type: "commit", total_packets: packetPos }));

        // Safety timeout
        window.setTimeout(() => {
          if (lastText?.trim()) {
            settle(makeResult(lastText));
          } else {
            fail(new Error("Transcription timed out"));
          }
        }, WS_RESPONSE_TIMEOUT_MS);
      });
    },

    abort() {
      if (settled) return;
      settled = true;
      phase = "done";
      buffer.length = 0;
      ws?.close();
      readyReject?.(new Error("Aborted"));
    },
  };
}
