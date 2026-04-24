/**
 * Dictation transcription proxy.
 *
 * The renderer captures microphone audio locally, WAV-encodes it (LINEAR16
 * PCM, 16 kHz mono), and POSTs the base64'd container here on stop. This
 * route forwards the request to Inworld's sync STT endpoint with Basic
 * auth so `INWORLD_API_KEY` never leaves the backend.
 *
 * We deliberately use the sync endpoint instead of the streaming
 * WebSocket: Inworld's WebSocket only honours JWTs in the
 * `Authorization` header, and browser WebSockets cannot set custom
 * headers, so the streaming variant would either expose the key or
 * require a stateful WebSocket proxy that Convex doesn't run.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";

const DICTATION_RATE_LIMIT = 30; // per minute
const DICTATION_RATE_WINDOW_MS = 60_000;

const INWORLD_TRANSCRIBE_URL = "https://api.inworld.ai/stt/v1/transcribe";
const INWORLD_DEFAULT_MODEL = "inworld/inworld-stt-1";
const INWORLD_DEFAULT_LANGUAGE = "en-US";

// Convex HTTP actions cap request bodies at ~20MB; base64 inflates by 33%
// so this keeps a comfortable margin for the JSON envelope.
const MAX_AUDIO_BASE64_BYTES = 14 * 1024 * 1024;

type TranscribeRequestBody = {
  audioBase64?: string;
  /**
   * Container/encoding hint for Inworld. Defaults to AUTO_DETECT so we can
   * accept whatever the renderer wraps the PCM in (today: WAV).
   */
  audioEncoding?: "AUTO_DETECT" | "LINEAR16" | "MP3" | "OGG_OPUS" | "FLAC";
  language?: string;
  modelId?: string;
};

export const registerDictationRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/dictation/transcribe"]);

  http.route({
    path: "/api/dictation/transcribe",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // Anonymous callers are allowed (no Convex identity required); we
        // rate-limit by signed-in identity → device id → shared bucket.
        const identity = await ctx.auth.getUserIdentity();
        const deviceId = request.headers.get("x-device-id")?.trim() || null;
        const rateLimitKey =
          identity?.tokenIdentifier ?? deviceId ?? "anonymous";

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "dictation_transcribe",
            key: rateLimitKey,
            limit: DICTATION_RATE_LIMIT,
            windowMs: DICTATION_RATE_WINDOW_MS,
            blockMs: DICTATION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const apiKey = process.env.INWORLD_API_KEY;
        if (!apiKey) {
          return errorResponse(
            503,
            "Dictation is not configured (missing INWORLD_API_KEY).",
            origin,
          );
        }

        let body: TranscribeRequestBody;
        try {
          body = (await request.json()) as TranscribeRequestBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const audioBase64 = body.audioBase64?.trim();
        if (!audioBase64) {
          return errorResponse(400, "audioBase64 is required", origin);
        }
        if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
          return errorResponse(
            413,
            "Audio clip too large; please dictate a shorter segment.",
            origin,
          );
        }

        const inworldBody = {
          transcribe_config: {
            model_id: body.modelId ?? INWORLD_DEFAULT_MODEL,
            language: body.language ?? INWORLD_DEFAULT_LANGUAGE,
            audio_encoding: body.audioEncoding ?? "AUTO_DETECT",
          },
          audio_data: { content: audioBase64 },
        };

        try {
          const inworldResponse = await fetch(INWORLD_TRANSCRIBE_URL, {
            method: "POST",
            headers: {
              Authorization: `Basic ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(inworldBody),
          });
          const text = await inworldResponse.text();
          if (!inworldResponse.ok) {
            console.error(
              "[dictation/transcribe] Inworld STT returned",
              inworldResponse.status,
              text,
            );
            return errorResponse(
              502,
              "Failed to transcribe audio",
              origin,
            );
          }
          let parsed: {
            transcription?: {
              transcript?: string;
              isFinal?: boolean;
            };
            usage?: { transcribedAudioMs?: number; modelId?: string };
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            return errorResponse(
              502,
              "Inworld returned a non-JSON transcription response",
              origin,
            );
          }
          return jsonResponse(
            {
              transcript: parsed.transcription?.transcript ?? "",
              isFinal: parsed.transcription?.isFinal ?? true,
              transcribedAudioMs: parsed.usage?.transcribedAudioMs ?? null,
              modelId: parsed.usage?.modelId ?? null,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error(
            "[dictation/transcribe] Failed to contact Inworld:",
            (error as Error).message,
          );
          return errorResponse(502, "Failed to transcribe audio", origin);
        }
      }),
    ),
  });
};
