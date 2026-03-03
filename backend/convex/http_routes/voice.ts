import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction } from "../auth";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import { getUserProviderKey } from "../lib/provider_keys";

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

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerVoiceRoutes = (http: HttpRouter) => {
  // --- Voice Session ---

  http.route({
    path: "/api/voice/session",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

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
            key: identity.subject,
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
        };
        let body: VoiceSessionBody | null = null;
        try {
          body = (await request.json()) as VoiceSessionBody;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        // Resolve owner ID from identity
        const ownerId = identity.subject;

        // Conversation ID is optional -- local-mode conversations use locally-generated
        // ULIDs (uppercase, digit-prefixed) that aren't valid Convex document IDs.
        // Only attempt ownership verification for IDs that look like Convex IDs
        // (lowercase, no leading digits) to avoid noisy validation errors in logs.
        let convexConversationId: Id<"conversations"> | undefined;
        const parsedConvId = asConvexConversationId(body?.conversationId);
        if (parsedConvId) {
          try {
            await requireConversationOwnerAction(ctx, parsedConvId);
            convexConversationId = parsedConvId;
          } catch (err) {
            console.warn("[voice/session] Conversation lookup failed:", err);
          }
        }

        const resolveOpenAiApiKey = async (): Promise<string | null> => {
          const byok = await getUserProviderKey(ctx, ownerId, "llm:openai");
          if (byok) return byok;
          return process.env.OPENAI_API_KEY ?? null;
        };

        const resolveDeviceStatus = async (): Promise<string | undefined> => {
          try {
            const deviceResult = await ctx.runQuery(
              internal.agent.device_resolver.getDeviceStatus,
              { ownerId },
            );
            const lines = ["# Device Status"];
            lines.push(
              `- Local device: ${deviceResult.localOnline ? "online" : "offline"}`,
            );
            return lines.join("\n");
          } catch (err) {
            console.warn("[voice/session] Failed to resolve device status:", err);
            return undefined;
          }
        };

        const resolveActiveThreads = async (): Promise<
          string | undefined
        > => {
          if (!convexConversationId) return undefined;
          try {
            const threads = await ctx.runQuery(
              internal.data.threads.listActiveThreads,
              {
                ownerId,
                conversationId: convexConversationId,
              },
            );
            const subagentThreads = (
              threads as Array<{
                _id: string;
                name: string;
                messageCount: number;
              }>
            ).filter((t) => t.name !== "Main");
            if (subagentThreads.length === 0) return undefined;
            const lines = ["# Active Threads"];
            for (const t of subagentThreads.slice(0, 10)) {
              lines.push(
                `- ${t.name} (id: ${t._id}, ${t.messageCount} messages)`,
              );
            }
            return lines.join("\n");
          } catch (err) {
            console.warn("[voice/session] Failed to resolve active threads:", err);
            return undefined;
          }
        };

        const [openaiApiKey, deviceStatus, activeThreads] = await Promise.all([
          resolveOpenAiApiKey(),
          resolveDeviceStatus(),
          resolveActiveThreads(),
        ]);

        if (!openaiApiKey) {
          return errorResponse(
            503,
            "No OpenAI API key configured. Add one in Settings or set OPENAI_API_KEY.",
            origin,
          );
        }

        // Build voice session instructions with dynamic context
        const [{ buildVoiceSessionInstructions }, { getVoiceToolSchemas }] =
          await Promise.all([
            import("../prompts/voice_orchestrator"),
            import("../tools/voice_schemas"),
          ]);

        let coreMemory: string | undefined;
        const userName =
          identity.name ?? identity.nickname ?? undefined;

        const instructions = buildVoiceSessionInstructions({
          userName,
          platform: "desktop",
          deviceStatus,
          activeThreads,
          coreMemory,
        });

        const tools = getVoiceToolSchemas();
        const model = body.model ?? "gpt-realtime-1.5";
        const voice = body.voice ?? "marin";

        // Request ephemeral client secret from OpenAI
        const turnDetection =
          body?.turnDetection === "semantic_vad"
            ? {
                type: "semantic_vad",
                eagerness: body.turnEagerness ?? "high",
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

  // --- Voice Transcript Logging ---

  http.route({
    path: "/api/voice/log",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/voice/log",
    method: "POST",
    handler: httpAction(async (_ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // Voice transcript/event logging is intentionally disabled.
        // Keep this endpoint as a no-op for older clients.
        return jsonResponse({ ok: true, skipped: true }, 200, origin);
      }),
    ),
  });
};
