/**
 * Mercury HTTP endpoint — fast voice routing layer.
 *
 * POST /api/mercury/chat
 *
 * Receives a voice request, routes through Mercury, and returns tool results
 * + text for the voice agent.
 */
import type { HttpRouter } from "convex/server";
import { stepCountIs } from "ai";
import { httpAction } from "../_generated/server";
import { resolveFallbackConfig, resolveModelConfig } from "../agent/model_resolver";
import { generateTextWithFailover } from "../agent/model_execution";
import {
  errorResponse,
  jsonResponse,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { createMercuryTools } from "../tools/mercury_schemas";
import type { MercuryToolResult } from "../tools/mercury_schemas";
import { buildMercurySystemPrompt } from "../prompts/mercury";

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerMercuryRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/mercury/chat",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: "/api/mercury/chat",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        // 1. Auth
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        // 2. Parse body
        let body: {
          message: string;
          conversationId?: string;
          windowState?: { windows: Array<{ type: string; title: string }> };
        };
        try {
          body = await request.json();
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (!body.message || typeof body.message !== "string") {
          return errorResponse(400, "Missing 'message' field", origin);
        }

        // 3. Resolve model config through the shared gateway/BYOK path
        const ownerId = identity.subject;
        const platformGatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
        const resolvedConfig = await resolveModelConfig(ctx, "mercury", ownerId);
        if (typeof resolvedConfig.model === "string" && !platformGatewayKey) {
          return errorResponse(
            503,
            "Mercury not configured — set AI_GATEWAY_API_KEY or add a compatible provider key",
            origin,
          );
        }
        const fallbackCandidate = await resolveFallbackConfig(ctx, "mercury", ownerId);
        const fallbackConfig =
          fallbackCandidate &&
          (typeof fallbackCandidate.model !== "string" || Boolean(platformGatewayKey))
            ? fallbackCandidate
            : null;

        // 4. Build system prompt with window state
        const systemPrompt = buildMercurySystemPrompt({
          windowState: body.windowState?.windows,
        });

        // 5. Create tools
        const tools = createMercuryTools(ctx, body.conversationId);

        // 6. Call Mercury via AI SDK
        try {
          const result = await generateTextWithFailover({
            resolvedConfig,
            fallbackConfig,
            sharedArgs: {
              system: systemPrompt,
              messages: [{ role: "user" as const, content: body.message }],
              tools,
              stopWhen: stepCountIs(3),
            },
          });

          // 7. Extract tool results from steps
          const toolResults: MercuryToolResult[] = [];
          for (const step of result.steps ?? []) {
            if (step.toolResults && Array.isArray(step.toolResults)) {
              for (const tc of step.toolResults) {
                const r = (tc as Record<string, unknown>).output as MercuryToolResult;
                if (r) toolResults.push(r);
              }
            }
          }

          return jsonResponse(
            {
              toolResults,
              text: result.text || null,
            },
            200,
            origin,
          );
        } catch (err) {
          console.error("[mercury] generateText failed:", err);
          return errorResponse(
            500,
            `Mercury error: ${(err as Error).message}`,
            origin,
          );
        }
      }),
    ),
  });
};
