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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SpeechToTextWsTokenRequest = {
  durationSecs?: number;
};

type SpeechToTextWsTokenResponse = {
  clientKey: string;
  expiresIn: number | null;
  websocketUrl: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRANSCRIBE_OWNER_RATE_LIMIT = 30;
const TRANSCRIBE_ANON_RATE_LIMIT = 10;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;
const DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 120;
const MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 30;
const MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 600;

const WISPRFLOW_GENERATE_ACCESS_TOKEN_URL =
  process.env.WISPRFLOW_GENERATE_ACCESS_TOKEN_URL?.trim() ||
  "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token";
const WISPRFLOW_CLIENT_WS_URL =
  process.env.WISPRFLOW_CLIENT_WS_URL?.trim() ||
  "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerSpeechToTextRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/speech-to-text/ws-token",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/speech-to-text/ws-token",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
          return errorResponse(401, "Unauthorized", origin);
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

        let body: SpeechToTextWsTokenRequest | null = null;
        try {
          body = (await request.json()) as SpeechToTextWsTokenRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (body && typeof body !== "object") {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (
          body?.durationSecs !== undefined &&
          (typeof body.durationSecs !== "number" ||
            !Number.isFinite(body.durationSecs))
        ) {
          return errorResponse(400, "durationSecs must be a number", origin);
        }

        const apiKey = process.env.WISPRFLOW_API_KEY;
        if (!apiKey) {
          console.error(
            "[speech-to-text/ws-token] Missing WISPRFLOW_API_KEY environment variable",
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const durationSecs = clampTokenDurationSeconds(body?.durationSecs);
        const clientIdSource = identity?.subject ?? anonDeviceId!;
        const clientId = clientIdSource.slice(0, 240);

        try {
          const upstreamResponse = await fetch(
            WISPRFLOW_GENERATE_ACCESS_TOKEN_URL,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                client_id: clientId,
                duration_secs: durationSecs,
                metadata: {
                  source: "stella",
                  feature: "voice",
                },
              }),
            },
          );

          const upstreamText = await upstreamResponse.text();
          if (!upstreamResponse.ok) {
            return errorResponse(
              upstreamResponse.status,
              `Speech session token request failed: ${upstreamResponse.status}`,
              origin,
            );
          }

          let upstreamJson: unknown;
          try {
            upstreamJson = upstreamText ? JSON.parse(upstreamText) : {};
          } catch {
            return errorResponse(502, "Invalid upstream response", origin);
          }

          const result = upstreamJson as {
            access_token?: unknown;
            expires_in?: unknown;
          };

          if (
            typeof result.access_token !== "string" ||
            result.access_token.trim().length === 0
          ) {
            return errorResponse(
              502,
              "Upstream response missing access token",
              origin,
            );
          }

          const response: SpeechToTextWsTokenResponse = {
            clientKey: result.access_token,
            expiresIn:
              typeof result.expires_in === "number"
                ? result.expires_in
                : null,
            websocketUrl: WISPRFLOW_CLIENT_WS_URL,
          };

          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[speech-to-text/ws-token] Error:", error);
          return errorResponse(
            500,
            "Speech session token request failed",
            origin,
          );
        }
      }),
    ),
  });
};
