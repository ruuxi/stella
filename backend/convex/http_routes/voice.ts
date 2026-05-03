import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction } from "../auth";
import {
  checkManagedUsageLimit,
} from "../lib/managed_billing";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  registerCorsOptions,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOICE_SESSION_RATE_LIMIT = 10; // per minute
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const asConvexConversationId = (
  value: unknown,
): Id<"conversations"> | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized as Id<"conversations">;
};

type VoiceUsageBody = {
  responseId?: string;
  model?: string;
  conversationId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_token_details?: {
      text_tokens?: number;
      audio_tokens?: number;
      image_tokens?: number;
      cached_tokens?: number;
      cached_text_tokens?: number;
      cached_audio_tokens?: number;
      cached_image_tokens?: number;
    };
    output_token_details?: {
      text_tokens?: number;
      audio_tokens?: number;
    };
  };
};

const toNonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const parseVoiceUsageBody = (body: VoiceUsageBody | null) => {
  const responseId = body?.responseId?.trim();
  const model = body?.model?.trim();
  if (!responseId || !model) {
    return null;
  }

  const inputDetails = body?.usage?.input_token_details ?? {};
  const outputDetails = body?.usage?.output_token_details ?? {};
  const textInputTokens = toNonNegativeInt(inputDetails.text_tokens);
  const audioInputTokens = toNonNegativeInt(inputDetails.audio_tokens);
  const imageInputTokens = toNonNegativeInt(inputDetails.image_tokens);
  const textCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_text_tokens ?? inputDetails.cached_tokens,
  );
  const audioCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_audio_tokens,
  );
  const imageCachedInputTokens = toNonNegativeInt(
    inputDetails.cached_image_tokens,
  );
  const textOutputTokens = toNonNegativeInt(outputDetails.text_tokens);
  const audioOutputTokens = toNonNegativeInt(outputDetails.audio_tokens);
  const inputTokens = toNonNegativeInt(body?.usage?.input_tokens)
    || (textInputTokens + audioInputTokens + imageInputTokens);
  const outputTokens = toNonNegativeInt(body?.usage?.output_tokens)
    || (textOutputTokens + audioOutputTokens);
  const totalTokens = toNonNegativeInt(body?.usage?.total_tokens) || (inputTokens + outputTokens);

  return {
    responseId,
    model,
    conversationId: asConvexConversationId(body?.conversationId),
    inputTokens,
    outputTokens,
    totalTokens,
    textInputTokens,
    textCachedInputTokens,
    textOutputTokens,
    audioInputTokens,
    audioCachedInputTokens,
    audioOutputTokens,
    imageInputTokens,
    imageCachedInputTokens,
  };
};

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerVoiceRoutes = (http: HttpRouter) => {
  // --- Voice Session ---

  registerCorsOptions(http, ["/api/voice/session", "/api/voice/usage"]);

  http.route({
    path: "/api/voice/session",
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
            scope: "voice_session",
            key: identity.tokenIdentifier,
            limit: VOICE_SESSION_RATE_LIMIT,
            windowMs: VOICE_SESSION_RATE_WINDOW_MS,
            blockMs: VOICE_SESSION_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        type VoiceSessionBody = {
          conversationId?: string;
          voice?: string;
          model?: string;
          turnDetection?: "semantic_vad" | "server_vad";
          turnEagerness?: "low" | "medium" | "high";
          instructions?: string;
        };
        let body: VoiceSessionBody | null = null;
        try {
          body = (await request.json()) as VoiceSessionBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const instructions = body?.instructions?.trim();
        if (!instructions) {
          return errorResponse(400, "instructions is required", origin);
        }

        // Resolve owner ID from identity
        const ownerId = identity.tokenIdentifier;
        const subscriptionCheck = await checkManagedUsageLimit(ctx, ownerId);
        if (!subscriptionCheck.allowed) {
          return errorResponse(429, subscriptionCheck.message, origin);
        }

        const resolveOpenAiApiKey = async (): Promise<string | null> =>
          process.env.OPENAI_API_KEY ?? null;

        const [openaiApiKey] = await Promise.all([
          resolveOpenAiApiKey(),
        ]);
        if (!openaiApiKey) {
          return errorResponse(
            503,
            "Voice sessions are not configured yet.",
            origin,
          );
        }

        const [{ getVoiceToolSchemas }] = await Promise.all([
          import("../tools/voice_schemas"),
        ]);

        const tools = getVoiceToolSchemas();
        const model = body.model ?? "gpt-realtime-1.5";
        const voice = body.voice ?? "marin";

        // Request ephemeral client secret from OpenAI
        const turnDetection =
          body?.turnDetection === "semantic_vad"
            ? {
                type: "semantic_vad",
                eagerness: body.turnEagerness ?? "medium",
                create_response: true,
                interrupt_response: true,
              }
            : {
                type: "server_vad",
                // Faster end-of-turn detection profile.
                threshold: 0.5,
                prefix_padding_ms: 120,
                silence_duration_ms: 220,
                create_response: true,
                interrupt_response: true,
              };

        const sessionConfig = {
          model,
          voice,
          instructions,
          tools,
          input_audio_transcription: {
            model: "gpt-4o-transcribe",
          },
          turn_detection: turnDetection,
        };

        try {
          const openaiResponse = await fetch(
            "https://api.openai.com/v1/realtime/sessions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(sessionConfig),
            },
          );

          const responseText = await openaiResponse.text();
          if (!openaiResponse.ok) {
            console.error(
              "[voice/session] OpenAI sessions failed:",
              openaiResponse.status,
              responseText,
            );
            return errorResponse(
              openaiResponse.status,
              "Failed to create voice session",
              origin,
            );
          }

          const openaiData = JSON.parse(responseText);
          return jsonResponse(
            {
              clientSecret:
                openaiData.client_secret?.value ??
                openaiData.client_secret,
              expiresAt: openaiData.client_secret?.expires_at,
              sessionId:
                typeof openaiData.id === "string" ? openaiData.id : undefined,
              model,
              voice,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error(
            "[voice/session] Failed to contact OpenAI:",
            (error as Error).message,
          );
          return errorResponse(502, "Failed to create voice session", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/voice/usage",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: VoiceUsageBody | null = null;
        try {
          body = (await request.json()) as VoiceUsageBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const parsed = parseVoiceUsageBody(body);
        if (!parsed) {
          return errorResponse(400, "responseId, model, and usage are required", origin);
        }

        let conversationId: Id<"conversations"> | undefined;
        if (parsed.conversationId) {
          try {
            await requireConversationOwnerAction(ctx, parsed.conversationId);
            conversationId = parsed.conversationId;
          } catch (err) {
            console.warn("[voice/usage] Conversation lookup failed:", err);
          }
        }

        const result = await ctx.runMutation(
          internal.billing.recordVoiceRealtimeUsage,
          {
            ownerId: identity.tokenIdentifier,
            responseId: parsed.responseId,
            model: parsed.model,
            ...(conversationId ? { conversationId } : {}),
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            totalTokens: parsed.totalTokens,
            textInputTokens: parsed.textInputTokens,
            textCachedInputTokens: parsed.textCachedInputTokens,
            textOutputTokens: parsed.textOutputTokens,
            audioInputTokens: parsed.audioInputTokens,
            audioCachedInputTokens: parsed.audioCachedInputTokens,
            audioOutputTokens: parsed.audioOutputTokens,
            imageInputTokens: parsed.imageInputTokens,
            imageCachedInputTokens: parsed.imageCachedInputTokens,
          },
        );

        return jsonResponse(
          {
            recorded: result.recorded,
            duplicate: result.duplicate,
            costMicroCents: result.costMicroCents,
          },
          200,
          origin,
        );
      }),
    ),
  });

};
