import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { MANAGED_GATEWAY } from "../agent/model";
import { resolveModelConfig } from "../agent/model_resolver";
import {
  buildCategoryAnalysisUserMessage,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildHomeSuggestionsPrompt,
  buildAppRecommendationsPrompt,
} from "../prompts/index";
import type { AppRecommendation, HomeSuggestion } from "../prompts/index";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
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
import {
  parseAppRecommendationsFromModelText,
  parseHomeSuggestionsFromModelText,
} from "../lib/welcome_suggestions_parse";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

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
  homeSuggestionsPromptTemplate?: string;
  appRecommendationsPromptTemplate?: string;
};

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions: HomeSuggestion[];
  appRecommendations: AppRecommendation[];
  categoryAnalyses?: Record<string, string>;
};

const DEFAULT_WELCOME_MESSAGE =
  "Hey! I'm Stella, your AI assistant. What can I help you with today?";
/**
 * Per-anonymous-device cap. Set effectively unlimited while testing; tighten
 * before shipping strict anon quotas.
 */
const MAX_ANON_SYNTHESIS_REQUESTS = Number.MAX_SAFE_INTEGER;
/**
 * Per-authenticated-owner cap on the same endpoint. Same rationale —
 * synthesis is one of the most expensive LLM endpoints in the stack, so
 * even a paid user shouldn't be able to fire dozens of jobs in a minute.
 */
const SYNTHESIS_OWNER_RATE_LIMIT = 10;
const SYNTHESIS_OWNER_RATE_WINDOW_MS = 60_000;

export const getHomeSuggestionsText = (
  result: { result: Parameters<typeof assistantText>[0] } | null | undefined,
): string => (result ? assistantText(result.result) : "");

export const registerSynthesisRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/synthesize"]);

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
        const homeSuggestionsPromptTemplate = body.homeSuggestionsPromptTemplate?.trim();
        const appRecommendationsPromptTemplate = body.appRecommendationsPromptTemplate?.trim();
        if (
          !coreMemorySystemPrompt ||
          !coreMemoryUserPromptTemplate ||
          !welcomeMessagePromptTemplate ||
          !homeSuggestionsPromptTemplate ||
          !appRecommendationsPromptTemplate
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
          const ownerId = identity?.tokenIdentifier;
          const isAnonymousIdentity =
            (identity as Record<string, unknown> | null)?.isAnonymous === true;
          const modelAccess = ownerId
            ? await resolveManagedModelAccess(ctx, ownerId, {
              isAnonymous: isAnonymousIdentity,
            })
            : undefined;

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

          const usageBlocked =
            modelAccess
            && !modelAccess.allowed
            && modelAccess.plan !== "free"
            && !isAnonymousIdentity;
          if (usageBlocked) {
            return errorResponse(429, modelAccess.message, origin);
          }

          if (
            ownerId
            && !isAnonymousIdentity
            && modelAccess
            && modelAccess.plan !== "free"
          ) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_owner",
              key: ownerId,
              limit: SYNTHESIS_OWNER_RATE_LIMIT,
              windowMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
              blockMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
            }
          }

          const synthesisConfig = await resolveModelConfig(ctx, "synthesis", ownerId, {
            access: modelAccess,
            audience: ownerId ? undefined : "anonymous",
          });

          let synthesisInput: string;
          const categoryAnalysesMap: Record<string, string> = {};

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
                const message = await completeManagedChat({
                  config: {
                    ...synthesisConfig,
                    maxOutputTokens: 30000,
                  },
                  context: {
                    systemPrompt,
                    messages: [{
                      role: "user",
                      content: [{
                        type: "text",
                        text: buildCategoryAnalysisUserMessage(
                          category,
                          sections[category],
                          categoryAnalysisUserPromptTemplate,
                        ),
                      }],
                      timestamp: Date.now(),
                    }],
                  },
                });
                const analysis = assistantText(message);
                const durationMs = Date.now() - startedAt;

                return {
                  category,
                  analysis,
                  durationMs,
                  usage: usageSummaryFromAssistant(message),
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

            const filteredResults = analysisResults
              .filter((result) => result.analysis.length > 0);

            synthesisInput = filteredResults
              .map((result) => result.analysis)
              .join("\n\n");

            for (const result of filteredResults) {
              categoryAnalysesMap[result.category] = result.analysis;
            }

            console.log(
              `[synthesize] Category analyses complete. Combined length: ${synthesisInput.length} chars`,
            );
          } else {
            synthesisInput = body.formattedSignals!;
          }

          console.log(
            `[synthesize] Core memory synthesis starting. Input length: ${synthesisInput.length} chars`,
          );
          const coreSynthesisStartedAt = Date.now();
          const synthesisMessage = await completeManagedChat({
            config: synthesisConfig,
            context: {
              systemPrompt: coreMemorySystemPrompt,
              messages: [{
                role: "user",
                content: [{
                  type: "text",
                  text: buildCoreSynthesisUserMessage(
                    synthesisInput,
                    coreMemoryUserPromptTemplate,
                  ),
                }],
                timestamp: Date.now(),
              }],
            },
          });

          if (ownerId) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:synthesis:core_memory",
              model: synthesisConfig.model,
              durationMs: Date.now() - coreSynthesisStartedAt,
              success: true,
              usage: usageSummaryFromAssistant(synthesisMessage),
            });
          }

          const coreMemory = assistantText(synthesisMessage);
          if (!coreMemory) {
            return errorResponse(500, "Failed to synthesize core memory", origin);
          }
          console.log(
            `[synthesize] Core memory synthesis complete in ${Date.now() - coreSynthesisStartedAt}ms. Output length: ${coreMemory.length} chars`,
          );

          const welcomeConfig = await resolveModelConfig(ctx, "welcome", ownerId, {
            access: modelAccess,
            audience: ownerId ? undefined : "anonymous",
          });

          console.log(
            "[synthesize] Welcome, home suggestions, and app recommendations starting",
          );
          const welcomeStartedAt = Date.now();
          const suggestionsStartedAt = Date.now();
          const appsStartedAt = Date.now();
          const [welcomeResult, suggestionsResult, appsResult] = await Promise.all([
            completeManagedChat({
              config: welcomeConfig,
              context: {
                messages: [{
                  role: "user",
                  content: [{
                    type: "text",
                    text: buildWelcomeMessagePrompt(
                      coreMemory,
                      welcomeMessagePromptTemplate,
                    ),
                  }],
                  timestamp: Date.now(),
                }],
              },
            }).then((result) => ({
              result,
              durationMs: Date.now() - welcomeStartedAt,
            })),
            completeManagedChat({
              config: welcomeConfig,
              context: {
                messages: [{
                  role: "user",
                  content: [{
                    type: "text",
                    text: buildHomeSuggestionsPrompt(
                      coreMemory,
                      homeSuggestionsPromptTemplate,
                    ),
                  }],
                  timestamp: Date.now(),
                }],
              },
            })
              .then((result) => ({
                result,
                durationMs: Date.now() - suggestionsStartedAt,
              }))
              .catch(() => null),
            completeManagedChat({
              config: welcomeConfig,
              context: {
                messages: [{
                  role: "user",
                  content: [{
                    type: "text",
                    text: buildAppRecommendationsPrompt(
                      coreMemory,
                      appRecommendationsPromptTemplate,
                    ),
                  }],
                  timestamp: Date.now(),
                }],
              },
            })
              .then((result) => ({
                result,
                durationMs: Date.now() - appsStartedAt,
              }))
              .catch(() => null),
          ]);
          console.log(
            `[synthesize] Welcome / home suggestions / app recommendations complete. welcome: ${welcomeResult.durationMs}ms, suggestions: ${suggestionsResult?.durationMs ?? "failed"}ms, apps: ${appsResult?.durationMs ?? "failed"}ms`,
          );

          if (ownerId) {
            await scheduleManagedUsage(ctx, {
              ownerId,
              agentType: "service:synthesis:welcome_message",
              model: welcomeConfig.model,
              durationMs: welcomeResult.durationMs,
              success: true,
              usage: usageSummaryFromAssistant(welcomeResult.result),
            });

            if (suggestionsResult) {
              await scheduleManagedUsage(ctx, {
                ownerId,
                agentType: "service:synthesis:home_suggestions",
                model: welcomeConfig.model,
                durationMs: suggestionsResult.durationMs,
                success: true,
                usage: usageSummaryFromAssistant(suggestionsResult.result),
              });
            }

            if (appsResult) {
              await scheduleManagedUsage(ctx, {
                ownerId,
                agentType: "service:synthesis:app_recommendations",
                model: welcomeConfig.model,
                durationMs: appsResult.durationMs,
                success: true,
                usage: usageSummaryFromAssistant(appsResult.result),
              });
            }
          }

          const suggestionsText = getHomeSuggestionsText(suggestionsResult);
          const suggestions = parseHomeSuggestionsFromModelText(
            suggestionsText,
          );
          if (!suggestions.length && suggestionsText) {
            console.warn(
              "[synthesize] Home suggestions: model output was not a usable JSON array",
              suggestionsText,
            );
          }

          const appRecommendationsText = appsResult
            ? assistantText(appsResult.result)
            : "";
          const appRecommendations = parseAppRecommendationsFromModelText(
            appRecommendationsText,
          );
          if (!appRecommendations.length && appRecommendationsText) {
            console.warn(
              "[synthesize] App recommendations: model output was not a usable JSON array",
              appRecommendationsText,
            );
          }

          const response: SynthesizeResponse = {
            coreMemory,
            welcomeMessage: assistantText(welcomeResult.result) || DEFAULT_WELCOME_MESSAGE,
            suggestions,
            appRecommendations,
            ...(Object.keys(categoryAnalysesMap).length > 0
              ? { categoryAnalyses: categoryAnalysesMap }
              : {}),
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
