import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { generateText, createGateway } from "ai";
import {
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
} from "../prompts/index";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";

const SKILL_RATE_LIMIT = 10;
const SKILL_RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillMetadataRequest = {
  markdown: string;
  skillDirName: string;
};

type SkillMetadataResponse = {
  metadata: {
    id: string;
    name: string;
    description: string;
    agentTypes: string[];
  };
};

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export const registerSkillRoutes = (http: HttpRouter) => {
  // --- Generate Skill Metadata ---

  http.route({
    path: "/api/generate-skill-metadata",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/generate-skill-metadata",
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
            scope: "skill_metadata",
            key: identity.subject,
            limit: SKILL_RATE_LIMIT,
            windowMs: SKILL_RATE_WINDOW_MS,
            blockMs: SKILL_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: SkillMetadataRequest | null = null;
        try {
          body = (await request.json()) as SkillMetadataRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (!body?.markdown || !body?.skillDirName) {
          return errorResponse(
            400,
            "markdown and skillDirName are required",
            origin,
          );
        }

        const apiKey = process.env.AI_GATEWAY_API_KEY;
        if (!apiKey) {
          console.error(
            "[generate-skill-metadata] Missing AI_GATEWAY_API_KEY environment variable",
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const gateway = createGateway({ apiKey });

        try {
          const userMessage = buildSkillMetadataUserMessage(
            body.skillDirName,
            body.markdown,
          );

          const result = await generateText({
            model: gateway("openai/gpt-4o-mini"),
            system: SKILL_METADATA_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            maxOutputTokens: 200,
            temperature: 0.3,
          });

          const text = result.text?.trim() || "";

          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            // Fallback to defaults if LLM output isn't valid JSON
          }

          const response: SkillMetadataResponse = {
            metadata: {
              id:
                (typeof parsed.id === "string" && parsed.id) ||
                body.skillDirName,
              name:
                (typeof parsed.name === "string" && parsed.name) ||
                body.skillDirName,
              description:
                (typeof parsed.description === "string" &&
                  parsed.description) ||
                "Skill instructions.",
              agentTypes:
                (Array.isArray(parsed.agentTypes)
                  ? parsed.agentTypes
                  : null) || ["general-purpose"],
            },
          };

          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[generate-skill-metadata] Error:", error);
          return errorResponse(500, "Metadata generation failed", origin);
        }
      }),
    ),
  });

  // --- Select Default Skills ---

  http.route({
    path: "/api/select-default-skills",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) =>
      corsPreflightHandler(request),
    ),
  });

  http.route({
    path: "/api/select-default-skills",
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
            scope: "skill_selection",
            key: identity.subject,
            limit: SKILL_RATE_LIMIT,
            windowMs: SKILL_RATE_WINDOW_MS,
            blockMs: SKILL_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: { userProfile?: string } | null = null;
        try {
          body = (await request.json()) as { userProfile?: string };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (!body?.userProfile) {
          return errorResponse(400, "userProfile is required", origin);
        }

        const apiKey = process.env.AI_GATEWAY_API_KEY;
        if (!apiKey) {
          console.error("[select-default-skills] Missing AI_GATEWAY_API_KEY");
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          // 1. Fetch all skills for this user
          const catalog = await ctx.runQuery(
            internal.data.skills.listAllSkillsForSelection,
            { ownerId: identity.subject },
          );

          if (catalog.length === 0) {
            return jsonResponse({ selectedSkillIds: [] }, 200, origin);
          }

          // 2. Call LLM to select relevant skills
          const gateway = createGateway({ apiKey });
          const userMessage = buildSkillSelectionUserMessage(
            body.userProfile,
            catalog,
          );

          const result = await generateText({
            model: gateway("openai/gpt-4o-mini"),
            system: SKILL_SELECTION_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            maxOutputTokens: 300,
            temperature: 0.3,
          });

          const text = (result.text ?? "").trim();

          // 3. Parse JSON array of skill IDs
          let selectedSkillIds: string[] = [];
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
              selectedSkillIds = parsed.filter(
                (id): id is string =>
                  typeof id === "string" && id.trim().length > 0,
              );
            }
          } catch {
            console.error(
              "[select-default-skills] Failed to parse LLM response:",
              text,
            );
          }

          // 4. Enable selected skills
          if (selectedSkillIds.length > 0) {
            await ctx.runMutation(internal.data.skills.enableSelectedSkills, {
              ownerId: identity.subject,
              skillIds: selectedSkillIds,
            });
          }

          return jsonResponse({ selectedSkillIds }, 200, origin);
        } catch (error) {
          console.error("[select-default-skills] Error:", error);
          return errorResponse(500, "Skill selection failed", origin);
        }
      }),
    ),
  });
};
