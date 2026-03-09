import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { createGateway, generateText } from "ai";
import { resolveModelConfig } from "../agent/model_resolver";
import {
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

type SynthesizeRequest = {
  formattedSignals: string;
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

        if (!body?.formattedSignals) {
          return errorResponse(400, "formattedSignals is required", origin);
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

        const apiKey = process.env.AI_GATEWAY_API_KEY;
        if (!apiKey) {
          console.error("[synthesize] Missing AI_GATEWAY_API_KEY environment variable");
          return errorResponse(500, "Server configuration error", origin);
        }

        const gateway = createGateway({ apiKey });

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
          const synthesisConfig = await resolveModelConfig(ctx, "synthesis", ownerId);
          const synthesisModel =
            typeof synthesisConfig.model === "string"
              ? gateway(synthesisConfig.model)
              : synthesisConfig.model;

          const synthesisResult = await generateText({
            model: synthesisModel,
            system: coreMemorySystemPrompt,
            messages: [{
              role: "user",
              content: buildCoreSynthesisUserMessage(
                body.formattedSignals,
                coreMemoryUserPromptTemplate,
              ),
            }],
            maxOutputTokens: synthesisConfig.maxOutputTokens,
            temperature: synthesisConfig.temperature,
            providerOptions: synthesisConfig.providerOptions,
          });

          const coreMemory = synthesisResult.text?.trim();
          if (!coreMemory) {
            return errorResponse(500, "Failed to synthesize core memory", origin);
          }

          const welcomeConfig = await resolveModelConfig(ctx, "welcome", ownerId);
          const welcomeModel =
            typeof welcomeConfig.model === "string"
              ? gateway(welcomeConfig.model)
              : welcomeConfig.model;

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
            }),
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
            }).catch(() => null),
          ]);

          let suggestions: WelcomeSuggestion[] = [];
          try {
            const parsed = JSON.parse(suggestionsResult?.text?.trim() || "[]");
            if (Array.isArray(parsed)) {
              suggestions = parsed.filter(isWelcomeSuggestion).slice(0, 5);
            }
          } catch (error) {
            console.warn("[synthesize] Suggestions generation failed:", error);
          }

          const response: SynthesizeResponse = {
            coreMemory,
            welcomeMessage: welcomeResult.text?.trim() || DEFAULT_WELCOME_MESSAGE,
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
