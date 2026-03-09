import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { generateText } from "ai";
import { getModelConfig, createManagedModel, MANAGED_GATEWAY } from "../agent/model";
import { buildSkillSelectionUserMessage } from "../prompts/index";
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
  systemPrompt?: string;
  userPrompt?: string;
};

type SkillMetadataResponse = {
  metadata: {
    id: string;
    name: string;
    description: string;
    agentTypes: string[];
  };
};

type SkillSelectionRequest = {
  userProfile?: string;
  systemPrompt?: string;
  userPromptTemplate?: string;
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
        const systemPrompt = body.systemPrompt?.trim();
        const userPrompt = body.userPrompt?.trim();
        if (!systemPrompt || !userPrompt) {
          return errorResponse(400, "systemPrompt and userPrompt are required", origin);
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(
            `[generate-skill-metadata] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} environment variable`,
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          const skillMetadataConfig = getModelConfig("skill_metadata");
          const result = await generateText({
            model: createManagedModel(skillMetadataConfig.model),
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            maxOutputTokens: skillMetadataConfig.maxOutputTokens,
            temperature: skillMetadataConfig.temperature,
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

        let body: SkillSelectionRequest | null = null;
        try {
          body = (await request.json()) as SkillSelectionRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        if (!body?.userProfile) {
          return errorResponse(400, "userProfile is required", origin);
        }
        const systemPrompt = body.systemPrompt?.trim();
        const userPromptTemplate = body.userPromptTemplate?.trim();
        if (!systemPrompt || !userPromptTemplate) {
          return errorResponse(400, "systemPrompt and userPromptTemplate are required", origin);
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(`[select-default-skills] Missing ${MANAGED_GATEWAY.apiKeyEnvVar}`);
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
          const skillSelectionConfig = getModelConfig("skill_selection");
          const userMessage = buildSkillSelectionUserMessage(
            body.userProfile,
            catalog,
            userPromptTemplate,
          );

          const result = await generateText({
            model: createManagedModel(skillSelectionConfig.model),
            system: systemPrompt,
            messages: [{ role: "user", content: userMessage }],
            maxOutputTokens: skillSelectionConfig.maxOutputTokens,
            temperature: skillSelectionConfig.temperature,
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
