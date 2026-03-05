/**
 * Mercury HTTP endpoint — fast voice routing layer.
 *
 * POST /api/mercury/chat
 *
 * Receives a voice request, routes through Mercury (Inception Labs mercury-2)
 * with AI SDK generateText, and returns tool results + text for the voice agent.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import {
  errorResponse,
  jsonResponse,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { getUserProviderKey } from "../lib/provider_keys";
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

        // 3. Resolve API key (BYOK or env var)
        const ownerId = identity.subject;
        let apiKey: string | null = null;
        try {
          const byok = await getUserProviderKey(ctx, ownerId, "llm:inception");
          if (byok) apiKey = byok;
        } catch {
          // BYOK lookup failed, fall through to env var
        }
        if (!apiKey) {
          apiKey = process.env.INCEPTION_API_KEY ?? null;
        }
        if (!apiKey) {
          return errorResponse(
            503,
            "Mercury not configured — set INCEPTION_API_KEY or add an Inception provider key",
            origin,
          );
        }

        // 4. Build system prompt with window state
        const systemPrompt = buildMercurySystemPrompt({
          windowState: body.windowState?.windows,
        });

        // 5. Create tools
        const tools = createMercuryTools(ctx, body.conversationId);

        // 6. Call Mercury via AI SDK
        try {
          // Dynamic import to avoid bundling issues in Convex
          const { generateText } = await import("ai");
          const { createOpenAI } = await import("@ai-sdk/openai");

          const model = createOpenAI({
            apiKey,
            baseURL: "https://api.inceptionlabs.ai/v1",
          }).chat("mercury-2");

          const { stepCountIs } = await import("ai");

          const result = await generateText({
            model,
            system: systemPrompt,
            messages: [{ role: "user" as const, content: body.message }],
            tools,
            stopWhen: stepCountIs(3),
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
