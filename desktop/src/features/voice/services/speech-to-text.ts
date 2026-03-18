import { createServiceRequest } from "@/infra/http/service-request";
import {
  TARGET_PCM_SAMPLE_RATE,
  decodeAudioBlobToMonoSamples,
  encodeInt16ToBase64,
  floatToInt16Pcm,
  resampleLinear,
} from "./audio-encoding";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const WS_CONNECT_TIMEOUT_MS = 15_000;
const WS_RESPONSE_TIMEOUT_MS = 45_000;
const SESSION_UPDATE_ACK_FALLBACK_MS = 750;
const PCM_CHUNK_SAMPLES = TARGET_PCM_SAMPLE_RATE;

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

type SpeechToTextSessionResponse = {
  clientSecret?: unknown;
  expiresAt?: unknown;
  sessionId?: unknown;
  websocketUrl?: unknown;
};

type RealtimeTranscriptionConfig = {
  clientSecret: string;
  expiresAt: number | null;
  sessionId: string | null;
  websocketUrl: string;
};

type RealtimeServerEvent = {
  type?: unknown;
  transcript?: unknown;
  delta?: unknown;
  item_id?: unknown;
  error?: unknown;
};

type RealtimeErrorBody = {
  message?: unknown;
  code?: unknown;
};

type RealtimeTranscriptionOptions = {
  language?: string[];
  context?: SpeechToTextContext;
  properties?: Record<string, unknown>;
};

type RealtimeConnection = {
  sendAudioChunk: (samples: Float32Array, sampleRate: number) => void;
  waitUntilReady: () => Promise<void>;
  commit: () => Promise<SpeechToTextResult>;
  abort: () => void;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const normalizeLanguageCode = (language: string[] | undefined): string | undefined => {
  if (!Array.isArray(language)) return undefined;
  const normalized = language.map((code) => code.trim()).find(Boolean);
  return normalized || undefined;
};

const extractPrompt = (options: RealtimeTranscriptionOptions): string | undefined => {
  const directPrompt =
    asString(options.properties?.prompt)
    ?? asString(options.context?.prompt)
    ?? asString(options.properties?.transcriptionPrompt)
    ?? asString(options.context?.transcriptionPrompt);
  const trimmed = directPrompt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const buildRealtimeSessionUpdate = (options: RealtimeTranscriptionOptions) => {
  const language = normalizeLanguageCode(options.language);
  const prompt = extractPrompt(options);

  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: TARGET_PCM_SAMPLE_RATE,
          },
          noise_reduction: {
            type: "near_field",
          },
          transcription: {
            model: "gpt-4o-transcribe",
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
};

const extractErrorDetail = (event: RealtimeServerEvent): string => {
  const error = event.error as RealtimeErrorBody | null | undefined;
  const message = asString(error?.message);
  const code = asString(error?.code);
  if (message && code) return `${message} (${code})`;
  return message ?? code ?? "Unknown realtime transcription error";
};

const makeResult = (
  text: string,
  id: string | null = null,
): SpeechToTextResult => ({
  id,
  text,
  detectedLanguage: null,
  totalTime: null,
  generatedTokens: null,
});

const resolveSpeechToTextSession = async (): Promise<RealtimeTranscriptionConfig> => {
  const { endpoint, headers } = await createServiceRequest("/api/speech-to-text/session", {
    "Content-Type": "application/json",
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Speech session failed: ${response.status} - ${errorText}`);
  }

  const json = (await response.json()) as SpeechToTextSessionResponse;
  if (typeof json.clientSecret !== "string" || json.clientSecret.trim().length === 0) {
    throw new Error("Speech session response missing clientSecret");
  }
  if (typeof json.websocketUrl !== "string" || json.websocketUrl.trim().length === 0) {
    throw new Error("Speech session response missing websocketUrl");
  }

  return {
    clientSecret: json.clientSecret,
    expiresAt: typeof json.expiresAt === "number" ? json.expiresAt : null,
    sessionId: typeof json.sessionId === "string" ? json.sessionId : null,
    websocketUrl: json.websocketUrl,
  };
};

const createRealtimeSocket = (config: RealtimeTranscriptionConfig): WebSocket => {
  return new WebSocket(config.websocketUrl, [
    "realtime",
    `openai-insecure-api-key.${config.clientSecret}`,
  ]);
};

const encodeChunkToBase64 = (
  samples: Float32Array,
  sampleRate: number,
): string => {
  const resampled = resampleLinear(samples, sampleRate, TARGET_PCM_SAMPLE_RATE);
  return encodeInt16ToBase64(floatToInt16Pcm(resampled));
};

const createRealtimeConnection = async (
  options: RealtimeTranscriptionOptions = {},
): Promise<RealtimeConnection> => {
  const config = await resolveSpeechToTextSession();
  const ws = createRealtimeSocket(config);
  const sessionUpdate = buildRealtimeSessionUpdate(options);

  let ready = false;
  let settled = false;
  let committed = false;
  let hasAudio = false;
  let lastTranscript = "";
  let lastItemId: string | null = null;
  let responseTimeout: ReturnType<typeof setTimeout> | null = null;
  let sessionAckTimeout: ReturnType<typeof setTimeout> | null = null;

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveCommit: ((result: SpeechToTextResult) => void) | null = null;
  let rejectCommit: ((error: Error) => void) | null = null;

  const clearTimers = () => {
    if (responseTimeout) {
      clearTimeout(responseTimeout);
      responseTimeout = null;
    }
    if (sessionAckTimeout) {
      clearTimeout(sessionAckTimeout);
      sessionAckTimeout = null;
    }
  };

  const settleSuccess = (result: SpeechToTextResult) => {
    if (settled) return;
    settled = true;
    clearTimers();
    resolveCommit?.(result);
    ws.close();
  };

  const settleFailure = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectReady?.(error);
    rejectCommit?.(error);
    ws.close();
  };

  const becomeReady = () => {
    if (ready || settled) return;
    ready = true;
    resolveReady?.();
  };

  const startCommitTimeout = () => {
    if (responseTimeout) {
      clearTimeout(responseTimeout);
    }
    responseTimeout = setTimeout(() => {
      if (lastTranscript.trim()) {
        settleSuccess(makeResult(lastTranscript, lastItemId));
      } else {
        settleFailure(new Error("Transcription timed out"));
      }
    }, WS_RESPONSE_TIMEOUT_MS);
  };

  const connectTimeout = setTimeout(() => {
    settleFailure(new Error("Speech websocket connection timed out"));
  }, WS_CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    ws.send(JSON.stringify(sessionUpdate));
    sessionAckTimeout = setTimeout(() => {
      becomeReady();
    }, SESSION_UPDATE_ACK_FALLBACK_MS);
  };

  ws.onmessage = (event) => {
    if (settled || typeof event.data !== "string") return;

    let message: RealtimeServerEvent;
    try {
      message = JSON.parse(event.data) as RealtimeServerEvent;
    } catch {
      return;
    }

    const type = asString(message.type);
    if (!type) return;

    switch (type) {
      case "session.created":
      case "session.updated":
      case "transcription_session.updated":
        becomeReady();
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = asString(message.delta);
        if (delta) {
          lastTranscript += delta;
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = asString(message.transcript);
        if (!transcript) return;
        lastTranscript = transcript;
        lastItemId = asString(message.item_id);
        if (committed) {
          settleSuccess(makeResult(transcript, lastItemId));
        }
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
      case "error":
        settleFailure(new Error(`Speech realtime error: ${extractErrorDetail(message)}`));
        break;
      default:
        break;
    }
  };

  ws.onerror = () => {
    settleFailure(new Error("Speech websocket connection failed"));
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
    if (settled) return;
    if (lastTranscript.trim()) {
      settleSuccess(makeResult(lastTranscript, lastItemId));
      return;
    }
    if (!ready) {
      settleFailure(new Error("Speech websocket closed before session became ready"));
      return;
    }
    settleFailure(new Error("Speech websocket closed before receiving transcription text"));
  };

  return {
    sendAudioChunk(samples: Float32Array, sampleRate: number) {
      if (settled || committed || ws.readyState !== WebSocket.OPEN) return;
      hasAudio = true;
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: encodeChunkToBase64(samples, sampleRate),
        }),
      );
    },

    waitUntilReady() {
      return readyPromise;
    },

    async commit() {
      if (settled) {
        throw new Error("Session already settled");
      }

      await readyPromise;

      if (!hasAudio) {
        settled = true;
        clearTimers();
        ws.close();
        return makeResult("");
      }

      if (committed) {
        throw new Error("Session already committed");
      }

      committed = true;
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      startCommitTimeout();

      return await new Promise<SpeechToTextResult>((resolve, reject) => {
        resolveCommit = resolve;
        rejectCommit = reject;
      });
    },

    abort() {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectReady?.(new Error("Aborted"));
      rejectCommit?.(new Error("Aborted"));
      ws.close();
    },
  };
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

  const [{ samples, sampleRate }, connection] = await Promise.all([
    decodeAudioBlobToMonoSamples(input.audio),
    createRealtimeConnection(input),
  ]);

  await connection.waitUntilReady();
  const resampled = resampleLinear(samples, sampleRate, TARGET_PCM_SAMPLE_RATE);
  for (let start = 0; start < resampled.length; start += PCM_CHUNK_SAMPLES) {
    const end = Math.min(start + PCM_CHUNK_SAMPLES, resampled.length);
    connection.sendAudioChunk(
      resampled.subarray(start, end),
      TARGET_PCM_SAMPLE_RATE,
    );
  }
  return await connection.commit();
}

export interface StreamingTranscribeSession {
  sendChunk(samples: Float32Array, sampleRate: number): void;
  commit(): Promise<SpeechToTextResult>;
  abort(): void;
}

type StreamingPhase = "connecting" | "ready" | "committed" | "done" | "error";

export function createStreamingSession(options?: {
  language?: string[];
  context?: SpeechToTextContext;
  properties?: Record<string, unknown>;
}): StreamingTranscribeSession {
  let phase: StreamingPhase = "connecting";
  let settled = false;
  let connectionPromise: Promise<RealtimeConnection> | null = createRealtimeConnection(options)
    .then((connection) => {
      return connection.waitUntilReady().then(() => {
        if (!settled) phase = "ready";
        return connection;
      });
    })
    .catch((error: unknown) => {
      phase = "error";
      throw error;
    });

  return {
    sendChunk(samples: Float32Array, sampleRate: number) {
      if (settled || phase === "committed" || phase === "done" || phase === "error") return;
      void connectionPromise?.then((connection) => {
        if (!settled && phase !== "committed" && phase !== "done") {
          connection.sendAudioChunk(samples, sampleRate);
        }
      });
    },

    async commit(): Promise<SpeechToTextResult> {
      if (phase === "error") throw new Error("Session failed");
      if (settled) throw new Error("Session already settled");

      phase = "committed";
      const connection = await connectionPromise!;
      try {
        const result = await connection.commit();
        settled = true;
        phase = "done";
        return result;
      } catch (error) {
        settled = true;
        phase = "error";
        throw error;
      }
    },

    abort() {
      if (settled) return;
      settled = true;
      phase = "done";
      void connectionPromise?.then((connection) => {
        connection.abort();
      });
      connectionPromise = null;
    },
  };
}
