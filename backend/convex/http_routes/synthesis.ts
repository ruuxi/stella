import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { generateText } from "ai";
import { usageSummaryFromResult } from "../agent/model_execution";
import { createManagedModel, MANAGED_GATEWAY } from "../agent/model";
import { resolveModelConfig } from "../agent/model_resolver";
import {
  buildCategoryAnalysisUserMessage,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
} from "../prompts/index";
import type { WelcomeSuggestion } from "../prompts/index";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
} from "../http_shared/cors";
import {
  getAnonDeviceId,
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../http_shared/anon_device";
import { getClientAddressKey } from "../lib/http_utils";
import {
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "../lib/managed_billing";

type SynthesizeRequest = {
  /** @deprecated Use formattedSections instead */
  formattedSignals?: string;
  formattedSections?: Record<string, string>;
  /** Per-category system prompts keyed by category ID */
  categoryAnalysisSystemPrompts?: Record<string, string>;
  categoryAnalysisUserPromptTemplate?: string;
  coreMemorySystemPrompt?: string;
  coreMemoryUserPromptTemplate?: string;
  welcomeMessagePromptTemplate?: string;
  welcomeSuggestionsPromptTemplate?: string;
};

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions: WelcomeSuggestion[];
};

const DEFAULT_WELCOME_MESSAGE =
  "Hey! I'm Stella, your AI assistant. What can I help you with today?";
const MAX_ANON_SYNTHESIS_REQUESTS = 10;

const isWelcomeSuggestion = (value: unknown): value is WelcomeSuggestion =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as WelcomeSuggestion).category === "string" &&
  typeof (value as WelcomeSuggestion).title === "string" &&
  typeof (value as WelcomeSuggestion).prompt === "string";

export const registerSynthesisRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/synthesize",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
  });

  http.route({
    path: "/api/synthesize",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: SynthesizeRequest | null = null;
        try {
          body = (await request.json()) as SynthesizeRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const hasFormattedSections =
          body?.formattedSections &&
          typeof body.formattedSections === "object" &&
          Object.keys(body.formattedSections).length > 0;
        const hasFormattedSignals =
          body?.formattedSignals && typeof body.formattedSignals === "string";

        if (!hasFormattedSections && !hasFormattedSignals) {
          return errorResponse(400, "formattedSections or formattedSignals is required", origin);
        }

        const coreMemorySystemPrompt = body.coreMemorySystemPrompt?.trim();
        const coreMemoryUserPromptTemplate = body.coreMemoryUserPromptTemplate?.trim();
        const welcomeMessagePromptTemplate = body.welcomeMessagePromptTemplate?.trim();
        const welcomeSuggestionsPromptTemplate = body.welcomeSuggestionsPromptTemplate?.trim();
        if (
          !coreMemorySystemPrompt ||
          !coreMemoryUserPromptTemplate ||
          !welcomeMessagePromptTemplate ||
          !welcomeSuggestionsPromptTemplate
        ) {
          return errorResponse(400, "Missing synthesis prompt payload", origin);
        }

        const categoryAnalysisSystemPrompts = body.categoryAnalysisSystemPrompts;
        const categoryAnalysisUserPromptTemplate = body.categoryAnalysisUserPromptTemplate?.trim();

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(`[synthesize] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} environment variable`);
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          if (!identity && anonDeviceId) {
            try {
              const usage = await ctx.runMutation(
                internal.ai_proxy_data.consumeDeviceAllowance,
                {
                  deviceId: anonDeviceId,
                  maxRequests: MAX_ANON_SYNTHESIS_REQUESTS,
                  clientAddressKey: getClientAddressKey(request) ?? undefined,
                },
              );
              if (!usage.allowed) {
                return errorResponse(
                  429,
                  "Rate limit exceeded. Please create an account for continued access.",
                  origin,
                );
              }
            } catch (error) {
              if (!isAnonDeviceHashSaltMissingError(error)) {
                throw error;
              }
              logMissingSaltOnce("synthesize");
            }
          }

          const ownerId = identity?.subject;
          const modelAccess = ownerId
            ? await resolveManagedModelAccess(ctx, ownerId, {
              isAnonymous: (identity as Record<string, unknown> | null)?.isAnonymous === true,
            })
            : undefined;
          if (modelAccess && !modelAccess.allowed) {
            return errorResponse(429, modelAccess.message, origin);
          }

          const synthesisConfig = await resolveModelConfig(ctx, "synthesis", ownerId, {
            access: modelAccess,
            audience: ownerId ? undefined : "anonymous",
          });
          const synthesisModel = createManagedModel(synthesisConfig.model);

          let synthesisInput: string;

          if (
            hasFormattedSections &&
            categoryAnalysisSystemPrompts &&
            Object.keys(categoryAnalysisSystemPrompts).length > 0 &&
            categoryAnalysisUserPromptTemplate
          ) {
            const sections = body.formattedSections!;
            const categoryKeys = Object.keys(sections).filter(
              (key) => sections[key] && sections[key].trim().length > 0,
            );

            console.log(
              `[synthesize] Running category analysis for ${categoryKeys.length} categories:`,
              categoryKeys,
            );

            const analysisResults = await Promise.all(
              categoryKeys.map(async (category) => {
                const systemPrompt = categoryAnalysisSystemPrompts[category];
                if (!systemPrompt) {
                  return {
                    category,
                    analysis: sections[category],
                    durationMs: 0,
                    usage: undefined,
                    generated: false,
                  };
                }

                const startedAt = Date.now();
                const result = await generateText({
                  model: synthesisModel,
                  system: systemPrompt,
                  messages: [{
                    role: "user",
                    content: buildCategoryAnalysisUserMessage(
                      category,
                      sections[category],
                      categoryAnalysisUserPromptTemplate,
                    ),
                  }],
                  maxOutputTokens: 8000,
                  temperature: synthesisConfig.temperature,
                  providerOptions: synthesisConfig.providerOptions,
                });

                return {
                  category,
                  analysis: result.text?.trim() ?? "",
                  durationMs: Date.now() - startedAt,
                  usage: usageSummaryFromResult(result),
                  generated: true,
                };
              }),
            );

            if (ownerId) {
              await Promise.all(
                analysisResults
                  .filter((result) => result.generated)
                  .map((result) =>
                    scheduleManagedUsage(ctx, {
                      ownerId,
                      agentType: "service:synthesis:category_analysis",
                      model: synthesisConfig.model,
                      durationMs: result.durationMs,
                      success: true,
                      usage: result.usage,
                    })),
              );
            }

            synthesisInput = analysisResults
              .filter((result) => result.analysis.length > 0)
              .map((result) => result.analysis)
              .join("\n\n");

            console.log(
              `[synthesize] Category analyses complete. Combined length: ${synthesisInput.length} chars`,
            );
          } else {
            synthesisInput = body.formattedSignals!;
          }

          const coreSynthesisStartedAt = Date.now();
          const synthesisResult = await generateText({
            model: synthesisModel,
            system: coreMemorySystemPrompt,
            messages: [{
              role: "user",
              content: buildCoreSynthesisUserMessage(
                synthesisInput,
                coreMemoryUserPromptTemplate,
              ),
            }],
            maxOutputTokens: synthesisConfig.maxOutputTokens,
            temperature: synthesisConfig.temperature,
            providerOptions: synthesisConfig.providerOptions,
          });

          if (ownerId) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:synthesis:core_memory",
              model: synthesisConfig.model,
              durationMs: Date.now() - coreSynthesisStartedAt,
              success: true,
              usage: usageSummaryFromResult(synthesisResult),
            });
          }

          const coreMemory = synthesisResult.text?.trim();
          if (!coreMemory) {
            return errorResponse(500, "Failed to synthesize core memory", origin);
          }

          const welcomeConfig = await resolveModelConfig(ctx, "welcome", ownerId, {
            access: modelAccess,
            audience: ownerId ? undefined : "anonymous",
          });
          const welcomeModel = createManagedModel(welcomeConfig.model);

          const welcomeStartedAt = Date.now();
          const suggestionsStartedAt = Date.now();
          const [welcomeResult, suggestionsResult] = await Promise.all([
            generateText({
              model: welcomeModel,
              messages: [{
                role: "user",
                content: buildWelcomeMessagePrompt(
                  coreMemory,
                  welcomeMessagePromptTemplate,
                ),
              }],
              maxOutputTokens: welcomeConfig.maxOutputTokens,
              temperature: welcomeConfig.temperature,
              providerOptions: welcomeConfig.providerOptions,
            }).then((result) => ({
              result,
              durationMs: Date.now() - welcomeStartedAt,
            })),
            generateText({
              model: welcomeModel,
              messages: [{
                role: "user",
                content: buildWelcomeSuggestionsPrompt(
                  coreMemory,
                  welcomeSuggestionsPromptTemplate,
                ),
              }],
              maxOutputTokens: 1024,
              temperature: 0.7,
              providerOptions: welcomeConfig.providerOptions,
            })
              .then((result) => ({
                result,
                durationMs: Date.now() - suggestionsStartedAt,
              }))
              .catch(() => null),
          ]);

          if (ownerId) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:synthesis:welcome_message",
              model: welcomeConfig.model,
              durationMs: welcomeResult.durationMs,
              success: true,
              usage: usageSummaryFromResult(welcomeResult.result),
            });

            if (suggestionsResult) {
              await scheduleManagedUsage(ctx, {
                ownerId,
                agentType: "service:synthesis:welcome_suggestions",
                model: welcomeConfig.model,
                durationMs: suggestionsResult.durationMs,
                success: true,
                usage: usageSummaryFromResult(suggestionsResult.result),
              });
            }
          }

          let suggestions: WelcomeSuggestion[] = [];
          try {
            const parsed = JSON.parse(suggestionsResult?.result.text?.trim() || "[]");
            if (Array.isArray(parsed)) {
              suggestions = parsed.filter(isWelcomeSuggestion).slice(0, 5);
            }
          } catch (error) {
            console.warn("[synthesize] Suggestions generation failed:", error);
          }

          const response: SynthesizeResponse = {
            coreMemory,
            welcomeMessage: welcomeResult.result.text?.trim() || DEFAULT_WELCOME_MESSAGE,
            suggestions,
          };

          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[synthesize] Error:", error);
          return errorResponse(500, "Synthesis failed", origin);
        }
      }),
    ),
  });
};
