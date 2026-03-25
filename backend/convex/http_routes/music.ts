import { GoogleGenAI, type LiveMusicServerMessage } from "@google/genai";
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MUSIC_STREAM_PATH = "/api/music/stream";
const MUSIC_KEY_PATH = "/api/music/api-key";
const MUSIC_STREAM_RATE_LIMIT = 10;
const MUSIC_STREAM_RATE_WINDOW_MS = 300_000;
const MUSIC_SSE_HEARTBEAT_MS = 15_000;
const MUSIC_AUTH_OR_QUOTA_CLOSE_CODES = new Set([1003, 1007, 1008, 1011]);
const MUSIC_MODEL = "models/lyria-realtime-exp";

type ParsedWeightedPrompt = {
  text: string;
  weight: number;
};

type ParsedMusicGenerationConfig = {
  bpm: number;
  density: number;
  brightness: number;
  guidance: number;
  temperature: number;
  music_generation_mode?: "VOCALIZATION";
};

type ParsedMusicStreamRequest = {
  weightedPrompts: ParsedWeightedPrompt[];
  musicGenerationConfig: ParsedMusicGenerationConfig;
  promptLabel: string | null;
};

const encoder = new TextEncoder();

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const sseData = (payload: unknown): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

const sseComment = (comment: string): Uint8Array =>
  encoder.encode(`: ${comment}\n\n`);

const parseMusicStreamRequest = (
  value: unknown,
): ParsedMusicStreamRequest | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const weightedPrompts = Array.isArray(record.weightedPrompts)
    ? record.weightedPrompts
    : null;
  const rawConfig =
    record.musicGenerationConfig &&
    typeof record.musicGenerationConfig === "object"
      ? (record.musicGenerationConfig as Record<string, unknown>)
      : null;

  if (!weightedPrompts?.length || !rawConfig) {
    return null;
  }

  const parsedWeightedPrompts = weightedPrompts
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const prompt = entry as Record<string, unknown>;
      const text = asTrimmedString(prompt.text);
      const weight = asFiniteNumber(prompt.weight);
      if (!text || weight === null || weight === 0) {
        return null;
      }
      return {
        text,
        weight: clamp(weight, -100, 100),
      } satisfies ParsedWeightedPrompt;
    })
    .filter((entry): entry is ParsedWeightedPrompt => entry !== null);

  if (!parsedWeightedPrompts.length) {
    return null;
  }

  const bpm = asFiniteNumber(rawConfig.bpm);
  const density = asFiniteNumber(rawConfig.density);
  const brightness = asFiniteNumber(rawConfig.brightness);
  const guidance = asFiniteNumber(rawConfig.guidance);
  const temperature = asFiniteNumber(rawConfig.temperature);

  if (
    bpm === null ||
    density === null ||
    brightness === null ||
    guidance === null ||
    temperature === null
  ) {
    return null;
  }

  const promptLabel = asTrimmedString(record.promptLabel);
  const music_generation_mode =
    rawConfig.music_generation_mode === "VOCALIZATION"
      ? "VOCALIZATION"
      : undefined;

  return {
    weightedPrompts: parsedWeightedPrompts,
    musicGenerationConfig: {
      bpm: clamp(bpm, 55, 145),
      density: clamp(density, 0.05, 0.9),
      brightness: clamp(brightness, 0.1, 0.8),
      guidance: clamp(guidance, 2, 5),
      temperature: clamp(temperature, 0.6, 1.4),
      ...(music_generation_mode ? { music_generation_mode } : {}),
    },
    promptLabel,
  };
};

const createMusicStream = (args: {
  request: Request;
  apiKey: string;
  parsedBody: ParsedMusicStreamRequest;
}) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let session: { close: () => void } | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = (options: { closeSession?: boolean } = {}) => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (options.closeSession !== false && session) {
          try {
            session.close();
          } catch {
            // Best-effort shutdown.
          }
          session = null;
        }
        try {
          controller.close();
        } catch {
          // Stream may already be closed.
        }
      };

      const enqueue = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseData(payload));
        } catch {
          cleanup();
        }
      };

      const enqueueComment = (comment: string) => {
        if (closed) return;
        try {
          controller.enqueue(sseComment(comment));
        } catch {
          cleanup();
        }
      };

      const fail = (message: string) => {
        enqueue({ type: "error", message });
        cleanup();
      };

      args.request.signal.addEventListener(
        "abort",
        () => {
          cleanup();
        },
        { once: true },
      );

      heartbeatTimer = setInterval(() => {
        enqueueComment("keepalive");
      }, MUSIC_SSE_HEARTBEAT_MS);
      enqueueComment("music-stream-open");

      void (async () => {
        try {
          const client = new GoogleGenAI({
            apiKey: args.apiKey,
            apiVersion: "v1alpha",
          });

          const liveSession = await client.live.music.connect({
            model: MUSIC_MODEL,
            callbacks: {
              onmessage: (message: LiveMusicServerMessage) => {
                const chunks = message.serverContent?.audioChunks?.filter(
                  (chunk) => typeof chunk?.data === "string",
                );
                if (!chunks?.length) {
                  return;
                }
                enqueue({
                  type: "audio",
                  chunks,
                });
              },
              onerror: (error: unknown) => {
                const message =
                  error instanceof Error ? error.message : String(error);
                enqueue({
                  type: "error",
                  message,
                });
              },
              onclose: (event: unknown) => {
                const closeEvent = event as
                  | { code?: number; reason?: string }
                  | undefined;
                const code = closeEvent?.code ?? 0;
                const reason = closeEvent?.reason?.trim() ?? "";

                if (!args.request.signal.aborted) {
                  enqueue({
                    type: "close",
                    code,
                    reason,
                  });

                  if (MUSIC_AUTH_OR_QUOTA_CLOSE_CODES.has(code)) {
                    enqueue({
                      type: "error",
                      message: reason || "Connection rejected by the music provider.",
                    });
                  } else if (code !== 1000) {
                    enqueue({
                      type: "error",
                      message: reason || "Music stream ended unexpectedly.",
                    });
                  }
                }

                cleanup({ closeSession: false });
              },
            },
          });

          session = liveSession;

          await liveSession.setWeightedPrompts({
            weightedPrompts: args.parsedBody.weightedPrompts,
          });
          await liveSession.setMusicGenerationConfig({
            musicGenerationConfig: args.parsedBody.musicGenerationConfig,
          });
          liveSession.play();

          enqueue({
            type: "ready",
            ...(args.parsedBody.promptLabel
              ? { promptLabel: args.parsedBody.promptLabel }
              : {}),
          });
        } catch (error) {
          fail(
            error instanceof Error
              ? error.message
              : "Failed to start music stream.",
          );
        }
      })();
    },
    cancel() {
      // The request abort listener handles cleanup.
    },
  });

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerMusicRoutes = (http: HttpRouter) => {
  for (const path of [MUSIC_STREAM_PATH, MUSIC_KEY_PATH]) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) =>
        corsPreflightHandler(request),
      ),
    });
  }

  http.route({
    path: MUSIC_STREAM_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "music_stream",
            key: identity.subject,
            limit: MUSIC_STREAM_RATE_LIMIT,
            windowMs: MUSIC_STREAM_RATE_WINDOW_MS,
            blockMs: MUSIC_STREAM_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          return errorResponse(400, "Invalid JSON body.", origin);
        }

        const parsedBody = parseMusicStreamRequest(body);
        if (!parsedBody) {
          return errorResponse(
            400,
            "weightedPrompts and musicGenerationConfig are required.",
            origin,
          );
        }

        const apiKey =
          await getUserProviderKey(ctx, identity.subject, "llm:google") ??
          process.env.GOOGLE_AI_API_KEY ??
          null;
        if (!apiKey) {
          return errorResponse(
            503,
            "No Google AI API key configured. Add one in Settings or contact your administrator.",
            origin,
          );
        }

        return withCors(
          new Response(
            createMusicStream({
              request,
              apiKey,
              parsedBody,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              },
            },
          ),
          origin,
        );
      }),
    ),
  });

  http.route({
    path: MUSIC_KEY_PATH,
    method: "POST",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) =>
        errorResponse(
          410,
          "Music API keys are no longer exposed to clients. Use /api/music/stream instead.",
          origin,
        ),
      ),
    ),
  });
};
