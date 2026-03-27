import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getAnonDeviceId } from "../http_shared/anon_device";
import { computeServiceCostMicroCents } from "../lib/billing_money";
import {
  checkManagedUsageLimit,
  scheduleManagedUsage,
} from "../lib/managed_billing";

type SpeechToTextSessionRequest = {
  durationSecs?: number;
};

type OpenAiClientSecretsResponse = {
  value?: unknown;
  expires_at?: unknown;
  session?: {
    id?: unknown;
  } | null;
};

type SpeechToTextSessionResponse = {
  clientSecret: string;
  expiresAt: number | null;
  sessionId: string | null;
  websocketUrl: string;
};

const TRANSCRIBE_OWNER_RATE_LIMIT = 30;
const TRANSCRIBE_ANON_RATE_LIMIT = 10;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;
const DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 60;
const MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 10;
const MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 600;
const OPENAI_REALTIME_WEBSOCKET_URL = "wss://api.openai.com/v1/realtime";

const clampTokenDurationSeconds = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS) {
    return MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }
  if (rounded > MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS) {
    return MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }
  return rounded;
};

export const registerSpeechToTextRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/speech-to-text/session",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/speech-to-text/session",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
          return errorResponse(401, "Unauthorized", origin);
        }

        if (identity) {
          const subscriptionCheck = await checkManagedUsageLimit(ctx, identity.subject);
          if (!subscriptionCheck.allowed) {
            return errorResponse(429, subscriptionCheck.message, origin);
          }
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: identity
              ? "speech_to_text_owner"
              : "speech_to_text_anon",
            key: identity?.subject ?? anonDeviceId!,
            limit: identity
              ? TRANSCRIBE_OWNER_RATE_LIMIT
              : TRANSCRIBE_ANON_RATE_LIMIT,
            windowMs: TRANSCRIBE_RATE_WINDOW_MS,
            blockMs: TRANSCRIBE_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: SpeechToTextSessionRequest | null = null;
        try {
          body = (await request.json()) as SpeechToTextSessionRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (body && typeof body !== "object") {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (
          body?.durationSecs !== undefined
          && (typeof body.durationSecs !== "number" || !Number.isFinite(body.durationSecs))
        ) {
          return errorResponse(400, "durationSecs must be a number", origin);
        }

        const openaiApiKey = process.env.OPENAI_API_KEY;
        if (!openaiApiKey) {
          console.error(
            "[speech-to-text/session] Missing OPENAI_API_KEY environment variable",
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const durationSecs = clampTokenDurationSeconds(body?.durationSecs);

        try {
          const openaiResponse = await fetch(
            "https://api.openai.com/v1/realtime/client_secrets",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                expires_after: {
                  anchor: "created_at",
                  seconds: durationSecs,
                },
                session: {
                  type: "transcription",
                  audio: {
                    input: {
                      format: {
                        type: "audio/pcm",
                        rate: 24_000,
                      },
                      noise_reduction: {
                        type: "near_field",
                      },
                      transcription: {
                        model: "gpt-4o-transcribe",
                      },
                      turn_detection: null,
                    },
                  },
                },
              }),
            },
          );

          const responseText = await openaiResponse.text();
          if (!openaiResponse.ok) {
            console.error(
              "[speech-to-text/session] OpenAI client secrets failed:",
              openaiResponse.status,
              responseText,
            );
            return errorResponse(
              openaiResponse.status,
              "Speech session request failed",
              origin,
            );
          }

          let openaiJson: OpenAiClientSecretsResponse;
          try {
            openaiJson = JSON.parse(responseText) as OpenAiClientSecretsResponse;
          } catch {
            return errorResponse(502, "Invalid upstream response", origin);
          }

          if (typeof openaiJson.value !== "string" || openaiJson.value.trim().length === 0) {
            return errorResponse(502, "Upstream response missing client secret", origin);
          }

          const response: SpeechToTextSessionResponse = {
            clientSecret: openaiJson.value,
            expiresAt:
              typeof openaiJson.expires_at === "number"
                ? openaiJson.expires_at
                : null,
            sessionId:
              typeof openaiJson.session?.id === "string"
                ? openaiJson.session.id
                : null,
            websocketUrl: OPENAI_REALTIME_WEBSOCKET_URL,
          };

          if (identity) {
            const serviceKey = "speech_to_text:realtime_session";
            await scheduleManagedUsage(ctx, {
              ownerId: identity.subject,
              agentType: "service:speech_to_text",
              model: serviceKey,
              durationMs: 0,
              success: true,
              costMicroCents: computeServiceCostMicroCents(serviceKey),
            });
          }

          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[speech-to-text/session] Error:", error);
          return errorResponse(500, "Speech session request failed", origin);
        }
      }),
    ),
  });
};
