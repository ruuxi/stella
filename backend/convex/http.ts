import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { generateText, createGateway } from "ai";
import { buildSystemPrompt } from "./agent/prompt_builder";
import { eventsToHistoryMessages } from "./agent/history_messages";
import {
  computeAutoCompactionThresholdTokens,
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
  SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS,
} from "./agent/context_budget";
import {
  finalizeOrchestratorTurn,
  prepareOrchestratorTurn,
} from "./agent/orchestrator_turn";
import { createTools } from "./tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "./agent/model_resolver";
import {
  streamTextWithFailover,
  usageSummaryFromFinish,
} from "./agent/model_execution";
import { beforeChat, afterChat } from "./agent/hooks";
import {
  assertSensitiveSessionPolicyAction,
  authComponent,
  createAuth,
  requireConversationOwnerAction,
} from "./auth";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
} from "./prompts/index";
import type { WelcomeSuggestion } from "./prompts/index";
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import {
  preflightCorsResponse,
  rejectDisallowedCorsOrigin,
  withCors,
} from "./http_shared/cors";
import { rateLimitResponse } from "./http_shared/webhook_controls";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "orchestrator" | "general";
};

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd /c start "" <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\`
`.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\`
`.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\`
`.trim();
  }

  return "";
};

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

const corsPreflightHandler = httpAction(async (_ctx, request) => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  return preflightCorsResponse(request);
});

http.route({
  path: "/api/chat",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }
    try {
      await assertSensitiveSessionPolicyAction(ctx, identity);
    } catch {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }
    let body: ChatRequest | null = null;
    try {
      body = (await request.json()) as ChatRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.conversationId || !body?.userMessageId) {
      return withCors(
        new Response("conversationId and userMessageId are required", {
          status: 400,
        }),
        origin,
      );
    }

    const conversationId = body.conversationId as Id<"conversations">;
    const userMessageId = body.userMessageId as Id<"events">;

    let conversation: Doc<"conversations"> | null = null;
    try {
      conversation = await requireConversationOwnerAction(ctx, conversationId);
    } catch {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }
    if (!conversation) {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }

    const userEvent = await ctx.runQuery(internal.events.getById, {
      id: userMessageId,
    });
    if (!userEvent || userEvent.type !== "user_message") {
      return withCors(new Response("User message not found", { status: 404 }), origin);
    }

    if (userEvent.conversationId !== conversationId) {
      return withCors(new Response("Conversation mismatch", { status: 400 }), origin);
    }

    const executionTarget = await ctx.runQuery(
      internal.agent.device_resolver.resolveExecutionTarget,
      { ownerId: conversation.ownerId },
    );
    // Prefer live device/cloud resolution; fall back to message deviceId for startup race windows.
    const targetDeviceId = executionTarget.targetDeviceId ?? userEvent.deviceId ?? undefined;
    const spriteName = targetDeviceId ? undefined : executionTarget.spriteName ?? undefined;
    if (spriteName) {
      await ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
        ownerId: conversation.ownerId,
      });
    }

    const userPayload =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string; platform?: string })
        : {};
    const userText = userPayload.text ?? "";
    const userPlatform = userPayload.platform ?? "unknown";
    const agentType =
      body.agent === "general"
        ? "general"
        : "orchestrator";

    const attachments = body.attachments ?? [];
    const resolvedImages: Array<{ url: string; mimeType?: string }> = [];
    for (const attachment of attachments) {
      if (attachment.id) {
        const record = await ctx.runQuery(internal.data.attachments.getById, {
          id: attachment.id as Id<"attachments">,
        });
        if (record) {
          const storageUrl =
            record.url ??
            (await ctx.storage.getUrl(record.storageKey as Id<"_storage">));
          if (storageUrl) {
            resolvedImages.push({
              url: storageUrl,
              mimeType: record.mimeType ?? undefined,
            });
          }
        }
        continue;
      }
      if (attachment.url) {
        resolvedImages.push({
          url: attachment.url,
          mimeType: attachment.mimeType,
        });
      }
    }

    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});
    const resolvedConfig = await resolveModelConfig(ctx, agentType, conversation.ownerId);
    const fallbackConfig = await resolveFallbackConfig(ctx, agentType, conversation.ownerId).catch(() => null);

    const activeThreadId = await ctx.runQuery(internal.conversations.getActiveThreadId, { conversationId });

    // Fallback to active thread if orchestrator or if no message ID provided
    const targetThreadId = activeThreadId;
    const platformGuidance = getPlatformGuidance(userPlatform);
    let promptBuild: Awaited<ReturnType<typeof buildSystemPrompt>>;
    let requestMessages: any[];
    let orchestratorTurn:
      | Awaited<ReturnType<typeof prepareOrchestratorTurn>>
      | null = null;

    if (agentType === "orchestrator") {
      orchestratorTurn = await prepareOrchestratorTurn(ctx, {
        conversation,
        conversationId,
        ownerId: conversation.ownerId,
        activeThreadId,
        userPayload: {
          kind: "chat",
          text: userText,
          images: resolvedImages,
          platformGuidance,
        },
        history: {
          enabled: true,
          beforeTimestamp: userEvent.timestamp,
          excludeEventId: userMessageId,
          microcompact: {
            trigger: "auto",
            modelForWarningThreshold:
              typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
          },
        },
      });
      promptBuild = orchestratorTurn.promptBuild;
      requestMessages = orchestratorTurn.messages;
    } else {
      promptBuild = await buildSystemPrompt(ctx, agentType, {
        ownerId: conversation.ownerId,
        conversationId,
      });
      const historyEvents = await ctx.runQuery(
        internal.events.listRecentContextEventsByTokens,
        {
          conversationId,
          beforeTimestamp: userEvent.timestamp,
          excludeEventId: userMessageId,
          contextAgentType: agentType,
        },
      );
      const historyBuild = eventsToHistoryMessages(historyEvents, {
        microcompact: {
          trigger: "auto",
          warningThresholdTokens: computeAutoCompactionThresholdTokens(
            typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
          ),
        },
      });
      if (historyBuild.microcompactBoundary) {
        try {
          await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId,
            type: "microcompact_boundary",
            payload: {
              ...historyBuild.microcompactBoundary,
              agentType,
            },
          });
        } catch {
          // Best effort: microcompact bookkeeping should never block chat.
        }
      }

      const contentParts: Array<
        { type: "text"; text: string } | { type: "image"; image: URL; mediaType?: string }
      > = [];
      const trimmedText = userText.trim();
      if (trimmedText.length > 0) {
        contentParts.push({ type: "text", text: trimmedText });
      }
      for (const image of resolvedImages) {
        try {
          contentParts.push({
            type: "image",
            image: new URL(image.url),
            mediaType: image.mimeType,
          });
        } catch {
          // Ignore invalid URLs.
        }
      }
      if (contentParts.length === 0) {
        contentParts.push({ type: "text", text: " " });
      }

      const contextParts: string[] = [];
      if (promptBuild.dynamicContext) contextParts.push(promptBuild.dynamicContext);
      if (platformGuidance) contextParts.push(platformGuidance);
      if (contextParts.length > 0) {
        contentParts.push({
          type: "text",
          text: `\n\n<system-context>\n${contextParts.join("\n\n")}\n</system-context>`,
        });
      }

      requestMessages = [
        ...historyBuild.messages,
        {
          role: "user",
          content: contentParts,
        },
      ];
    }

    // --- beforeChat hook: rate limiting ---
    const beforeResult = await beforeChat(ctx, {
      ownerId: conversation.ownerId,
      conversationId,
      agentType,
      modelString: resolvedConfig.model as string,
    });
    if (!beforeResult.allowed) {
      return withCors(rateLimitResponse(beforeResult.retryAfterMs ?? 60_000), origin);
    }

    const chatStartTime = Date.now();

    const streamTextSharedArgs = {
      system: promptBuild.systemPrompt,
      tools: createTools(
        ctx,
        targetDeviceId
          ? {
              conversationId,
              userMessageId,
              targetDeviceId,
              agentType,
              sourceDeviceId: userEvent.deviceId,
            }
          : undefined,
        {
          agentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          ownerId: conversation.ownerId,
          conversationId,
          userMessageId,
          targetDeviceId,
          spriteName,
        },
      ),
      messages: requestMessages,
      abortSignal: request.signal,
      onFinish: async ({ text, usage, totalUsage, response }: { text: string; usage: any; totalUsage: any; response: any }) => {
        const usageSummary = usageSummaryFromFinish(usage, totalUsage);

        if (agentType === "orchestrator" && orchestratorTurn) {
          await finalizeOrchestratorTurn(ctx, {
            conversationId,
            ownerId: conversation.ownerId,
            userMessageId,
            activeThreadId: orchestratorTurn.activeThreadId,
            threadUserMessage: orchestratorTurn.threadUserMessage,
            responseMessages: response?.messages,
            assistantText: text,
            usage: usageSummary,
            reminderState: orchestratorTurn.reminderState,
            afterChat: {
              modelString: resolvedConfig.model as string,
              durationMs: Date.now() - chatStartTime,
              success: true,
            },
          });
          return;
        }

        if (text.trim().length > 0) {
          await ctx.runMutation(internal.events.saveAssistantMessage, {
            conversationId,
            text,
            userMessageId,
            usage: usageSummary,
          });
        }

        if (targetThreadId) {
          const messagesToSave: Array<{
            role: string;
            content: string;
            toolCallId?: string;
            tokenEstimate?: number;
          }> = [
            { role: "user", content: userText },
          ];

          if (response?.messages) {
            for (const msg of response.messages) {
              const rawToolCallId = (msg as { toolCallId?: unknown }).toolCallId;
              const toolCallId = typeof rawToolCallId === "string" 
                ? rawToolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) 
                : undefined;
              
              messagesToSave.push({
                role: msg.role,
                content: JSON.stringify({
                  role: msg.role,
                  content: msg.content,
                  ...(toolCallId ? { toolCallId } : {}),
                }),
                ...(toolCallId ? { toolCallId } : {}),
              });
            }
          }

          if (messagesToSave.length > 1) {
            await ctx.runMutation(internal.data.threads.saveThreadMessages, {
              ownerId: conversation.ownerId,
              threadId: targetThreadId,
              messages: messagesToSave,
            });

            const updatedThread = await ctx.runQuery(internal.data.threads.getThreadById, {
              threadId: targetThreadId,
            });
            const compactionThresholdTokens = agentType === "orchestrator"
              ? ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
              : SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS;
            if (
              (updatedThread?.totalTokenEstimate ?? 0) >=
              compactionThresholdTokens
            ) {
              await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
                threadId: targetThreadId,
              });
            }
          }
        }

        await afterChat(ctx, {
          ownerId: conversation.ownerId,
          conversationId,
          agentType,
          modelString: resolvedConfig.model as string,
          usage: usageSummary,
          durationMs: Date.now() - chatStartTime,
          success: true,
        });

        // Best-effort command suggestions after each response.
        try {
          await ctx.scheduler.runAfter(0, internal.agent.suggestions.generateSuggestions, {
            conversationId,
            ownerId: conversation.ownerId,
          });
        } catch { /* best-effort */ }
      },
    };

    const result = await streamTextWithFailover({
      resolvedConfig: resolvedConfig as Record<string, unknown>,
      fallbackConfig: (fallbackConfig ?? undefined) as Record<string, unknown> | undefined,
      sharedArgs: streamTextSharedArgs as Record<string, unknown>,
    });

    const response = result.toUIMessageStreamResponse();
    return withCors(response, origin);
  }),
});

// ---------------------------------------------------------------------------
// Core Memory Synthesis Endpoint
// ---------------------------------------------------------------------------

type SynthesizeRequest = {
  formattedSignals: string;
};

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions: WelcomeSuggestion[];
};
const DEFAULT_WELCOME_MESSAGE = "Hey! I'm Stella, your AI assistant. What can I help you with today?";
const MAX_ANON_SYNTHESIS_REQUESTS = 10;
const ANON_DEVICE_HASH_SALT_MISSING_MESSAGE = "Missing ANON_DEVICE_ID_HASH_SALT";
let didLogMissingAnonDeviceSaltForSynthesis = false;
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128;
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/;
const TRANSCRIBE_OWNER_RATE_LIMIT = 30;
const TRANSCRIBE_ANON_RATE_LIMIT = 10;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;

const MUSIC_KEY_RATE_LIMIT = 10;
const MUSIC_KEY_RATE_WINDOW_MS = 300_000;
const DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 120;
const MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 30;
const MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 600;
const WISPRFLOW_GENERATE_ACCESS_TOKEN_URL =
  process.env.WISPRFLOW_GENERATE_ACCESS_TOKEN_URL?.trim() ||
  process.env.WISPR_FLOW_GENERATE_ACCESS_TOKEN_URL?.trim() ||
  "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token";
const WISPRFLOW_CLIENT_WS_URL =
  process.env.WISPRFLOW_CLIENT_WS_URL?.trim() ||
  process.env.WISPR_FLOW_CLIENT_WS_URL?.trim() ||
  "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";

type SpeechToTextWsTokenRequest = {
  durationSecs?: number;
};

type SpeechToTextWsTokenResponse = {
  clientKey: string;
  expiresIn: number | null;
  websocketUrl: string;
};

const getAnonDeviceId = (request: Request): string | null => {
  const deviceId = request.headers.get("X-Device-ID");
  if (!deviceId) return null;
  const trimmed = deviceId.trim();
  if (trimmed.length === 0 || trimmed.length >= 256) return null;
  return trimmed;
};

const isAnonDeviceHashSaltMissingError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(ANON_DEVICE_HASH_SALT_MISSING_MESSAGE);

const normalizeClientAddressKey = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CLIENT_ADDRESS_KEY_LENGTH ||
    !CLIENT_ADDRESS_KEY_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};

const getClientAddressKey = (request: Request): string | null => {
  const cloudflareIp = normalizeClientAddressKey(request.headers.get("cf-connecting-ip"));
  if (cloudflareIp) return cloudflareIp;

  const realIp = normalizeClientAddressKey(request.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const firstHop = forwardedFor.split(",")[0] ?? "";
  return normalizeClientAddressKey(firstHop);
};

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

http.route({
  path: "/api/synthesize",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/synthesize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    const anonDeviceId = getAnonDeviceId(request);
    if (!identity && !anonDeviceId) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: SynthesizeRequest | null = null;
    try {
      body = (await request.json()) as SynthesizeRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.formattedSignals) {
      return withCors(
        new Response("formattedSignals is required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[synthesize] Missing AI_GATEWAY_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const gateway = createGateway({ apiKey });

    try {
      if (!identity && anonDeviceId) {
        try {
          const usage = await ctx.runMutation(internal.ai_proxy_data.consumeDeviceAllowance, {
            deviceId: anonDeviceId,
            maxRequests: MAX_ANON_SYNTHESIS_REQUESTS,
            clientAddressKey: getClientAddressKey(request) ?? undefined,
          });
          if (!usage.allowed) {
            return withCors(
              new Response(
                JSON.stringify({
                  error:
                    "Rate limit exceeded. Please create an account for continued access.",
                }),
                {
                  status: 429,
                  headers: { "Content-Type": "application/json" },
                },
              ),
              origin,
            );
          }
        } catch (error) {
          if (!isAnonDeviceHashSaltMissingError(error)) {
            throw error;
          }
          if (!didLogMissingAnonDeviceSaltForSynthesis) {
            didLogMissingAnonDeviceSaltForSynthesis = true;
            console.warn(
              "[synthesize] Missing ANON_DEVICE_ID_HASH_SALT; anonymous rate limiting is disabled until configured.",
            );
          }
        }
      }

      const ownerId = identity?.subject;
      const synthesisConfig = await resolveModelConfig(ctx, "synthesis", ownerId);
      const userMessage = buildCoreSynthesisUserMessage(body.formattedSignals);

      const synthesisModel = typeof synthesisConfig.model === "string"
        ? gateway(synthesisConfig.model)
        : synthesisConfig.model;
      const synthesisResult = await generateText({
        model: synthesisModel,
        system: CORE_MEMORY_SYNTHESIS_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: synthesisConfig.maxOutputTokens,
        temperature: synthesisConfig.temperature,
        providerOptions: synthesisConfig.providerOptions,
      });

      const coreMemory = synthesisResult.text?.trim();
      if (!coreMemory) {
        return withCors(
          new Response("Failed to synthesize core memory", { status: 500 }),
          origin,
        );
      }

      const welcomeConfig = await resolveModelConfig(ctx, "welcome", ownerId);
      const welcomePrompt = buildWelcomeMessagePrompt(coreMemory);

      const welcomeModel = typeof welcomeConfig.model === "string"
        ? gateway(welcomeConfig.model)
        : welcomeConfig.model;

      // Run welcome message and suggestions in parallel (both only need coreMemory)
      const suggestionsPrompt = buildWelcomeSuggestionsPrompt(coreMemory);

      const [welcomeResult, suggestionsResult] = await Promise.all([
        generateText({
          model: welcomeModel,
          messages: [{ role: "user", content: welcomePrompt }],
          maxOutputTokens: welcomeConfig.maxOutputTokens,
          temperature: welcomeConfig.temperature,
          providerOptions: welcomeConfig.providerOptions,
        }),
        generateText({
          model: welcomeModel,
          messages: [{ role: "user", content: suggestionsPrompt }],
          maxOutputTokens: 1024,
          temperature: 0.7,
        }).catch(() => null),
      ]);

      let suggestions: WelcomeSuggestion[] = [];
      try {
        const raw = suggestionsResult?.text?.trim() || "";
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          suggestions = parsed
            .filter(
              (s: unknown): s is WelcomeSuggestion =>
                typeof s === "object" &&
                s !== null &&
                typeof (s as WelcomeSuggestion).category === "string" &&
                typeof (s as WelcomeSuggestion).title === "string" &&
                typeof (s as WelcomeSuggestion).prompt === "string",
            )
            .slice(0, 5);
        }
      } catch {
        // Suggestions are non-critical — fallback to empty array
      }

      const response: SynthesizeResponse = {
        coreMemory,
        welcomeMessage: welcomeResult.text?.trim() || DEFAULT_WELCOME_MESSAGE,
        suggestions,
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[synthesize] Error:", error);
      return withCors(
        new Response(`Synthesis failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Speech-To-Text Endpoint
// ---------------------------------------------------------------------------

http.route({
  path: "/api/speech-to-text/ws-token",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/speech-to-text/ws-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    const anonDeviceId = getAnonDeviceId(request);
    if (!identity && !anonDeviceId) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: identity ? "speech_to_text_owner" : "speech_to_text_anon",
      key: identity?.subject ?? anonDeviceId!,
      limit: identity ? TRANSCRIBE_OWNER_RATE_LIMIT : TRANSCRIBE_ANON_RATE_LIMIT,
      windowMs: TRANSCRIBE_RATE_WINDOW_MS,
      blockMs: TRANSCRIBE_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    let body: SpeechToTextWsTokenRequest | null = null;
    try {
      body = (await request.json()) as SpeechToTextWsTokenRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (
      body &&
      typeof body !== "object"
    ) {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (
      body?.durationSecs !== undefined &&
      (typeof body.durationSecs !== "number" || !Number.isFinite(body.durationSecs))
    ) {
      return withCors(new Response("durationSecs must be a number", { status: 400 }), origin);
    }

    const apiKey = process.env.WISPRFLOW_API_KEY ?? process.env.WISPR_FLOW_API_KEY;
    if (!apiKey) {
      console.error("[speech-to-text/ws-token] Missing WISPRFLOW_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const durationSecs = clampTokenDurationSeconds(body?.durationSecs);
    const clientIdSource = identity?.subject ?? anonDeviceId!;
    const clientId = clientIdSource.slice(0, 240);

    try {
      const upstreamResponse = await fetch(WISPRFLOW_GENERATE_ACCESS_TOKEN_URL, {
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
      });

      const upstreamText = await upstreamResponse.text();
      if (!upstreamResponse.ok) {
        return withCors(
          new Response(
            JSON.stringify({
              error: `Speech session token request failed: ${upstreamResponse.status}`,
              detail: upstreamText.slice(0, 2_000),
            }),
            {
              status: upstreamResponse.status,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      let upstreamJson: unknown;
      try {
        upstreamJson = upstreamText ? JSON.parse(upstreamText) : {};
      } catch {
        return withCors(
          new Response(
            JSON.stringify({ error: "Invalid upstream response" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      const result = upstreamJson as {
        access_token?: unknown;
        expires_in?: unknown;
      };

      if (typeof result.access_token !== "string" || result.access_token.trim().length === 0) {
        return withCors(
          new Response(
            JSON.stringify({ error: "Upstream response missing access token" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      const response: SpeechToTextWsTokenResponse = {
        clientKey: result.access_token,
        expiresIn: typeof result.expires_in === "number" ? result.expires_in : null,
        websocketUrl: WISPRFLOW_CLIENT_WS_URL,
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[speech-to-text/ws-token] Error:", error);
      return withCors(
        new Response(`Speech session token request failed: ${(error as Error).message}`, {
          status: 500,
        }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Memory Seeding Endpoint (discovery -> ephemeral memory)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/seed-memories",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/seed-memories",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    try {
      const body = (await request.json()) as { formattedSignals?: string };
      if (!body?.formattedSignals) {
        return withCors(
          new Response("Missing formattedSignals", { status: 400 }),
          origin,
        );
      }

      // Schedule seeding as async action (non-blocking)
      await ctx.scheduler.runAfter(0, internal.data.memory.seedFromDiscovery, {
        ownerId: identity.subject,
        formattedSignals: body.formattedSignals,
      });

      return withCors(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[seed-memories] Error:", error);
      return withCors(
        new Response(`Seed failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Skill Metadata Generation Endpoint
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

http.route({
  path: "/api/generate-skill-metadata",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/generate-skill-metadata",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: SkillMetadataRequest | null = null;
    try {
      body = (await request.json()) as SkillMetadataRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.markdown || !body?.skillDirName) {
      return withCors(
        new Response("markdown and skillDirName are required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[generate-skill-metadata] Missing AI_GATEWAY_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const gateway = createGateway({ apiKey });

    try {
      const userMessage = buildSkillMetadataUserMessage(body.skillDirName, body.markdown);

      const result = await generateText({
        model: gateway("openai/gpt-4o-mini"),
        system: SKILL_METADATA_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: 200,
        temperature: 0.3,
      });

      const text = result.text?.trim() || "";

      // Parse the YAML response
      const lines = text.split("\n");
      const metadata: Record<string, unknown> = {};

      for (const line of lines) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();

        // Handle array values like [general-purpose]
        if (value.startsWith("[") && value.endsWith("]")) {
          const inner = value.slice(1, -1);
          metadata[key] = inner
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter((s) => s.length > 0);
        } else {
          // Remove surrounding quotes
          value = value.replace(/^["']|["']$/g, "");
          metadata[key] = value;
        }
      }

      const response: SkillMetadataResponse = {
        metadata: {
          id: (metadata.id as string) || body.skillDirName,
          name: (metadata.name as string) || body.skillDirName,
          description: (metadata.description as string) || "Skill instructions.",
          agentTypes: (metadata.agentTypes as string[]) || ["general-purpose"],
        },
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[generate-skill-metadata] Error:", error);
      return withCors(
        new Response(`Metadata generation failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Default Skill Selection Endpoint (onboarding)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/select-default-skills",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/select-default-skills",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: { coreMemory?: string } | null = null;
    try {
      body = (await request.json()) as { coreMemory?: string };
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.coreMemory) {
      return withCors(
        new Response("coreMemory is required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[select-default-skills] Missing AI_GATEWAY_API_KEY");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    try {
      // 1. Fetch all skills for this user
      const catalog = await ctx.runQuery(
        internal.data.skills.listAllSkillsForSelection,
        { ownerId: identity.subject },
      );

      if (catalog.length === 0) {
        return withCors(
          new Response(JSON.stringify({ selectedSkillIds: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          origin,
        );
      }

      // 2. Call LLM to select relevant skills
      const gateway = createGateway({ apiKey });
      const userMessage = buildSkillSelectionUserMessage(body.coreMemory, catalog);

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
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          );
        }
      } catch {
        console.error("[select-default-skills] Failed to parse LLM response:", text);
      }

      // 4. Enable selected skills
      if (selectedSkillIds.length > 0) {
        await ctx.runMutation(internal.data.skills.enableSelectedSkills, {
          ownerId: identity.subject,
          skillIds: selectedSkillIds,
        });
      }

      return withCors(
        new Response(JSON.stringify({ selectedSkillIds }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[select-default-skills] Error:", error);
      return withCors(
        new Response(`Skill selection failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

registerConnectorWebhookRoutes(http);

// ---------------------------------------------------------------------------
// Stella AI Proxy — thin LLM/embed/search proxy for desktop local runtime
// ---------------------------------------------------------------------------

import { proxyChat, proxyEmbed, proxySearch, llmProxy } from "./ai_proxy";

const proxyOptionsHandler = httpAction(async (_ctx, request) => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  return preflightCorsResponse(request);
});

http.route({ path: "/api/ai/proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/proxy", method: "POST", handler: proxyChat });

http.route({ path: "/api/ai/embed", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/embed", method: "POST", handler: proxyEmbed });

http.route({ path: "/api/ai/search", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/search", method: "POST", handler: proxySearch });

// Transparent LLM reverse proxy for local agent runtime
http.route({ path: "/api/ai/llm-proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/llm-proxy", method: "POST", handler: llmProxy });

// ---------------------------------------------------------------------------
// Music Generation — API Key Endpoint
// ---------------------------------------------------------------------------

http.route({
  path: "/api/music/api-key",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/music/api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    // Require authenticated user (no anonymous access for API key distribution)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "music_api_key",
      key: identity.subject,
      limit: MUSIC_KEY_RATE_LIMIT,
      windowMs: MUSIC_KEY_RATE_WINDOW_MS,
      blockMs: MUSIC_KEY_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    // Resolve Google AI API key via BYOK chain, then platform env var
    const ownerId = identity.subject;
    let apiKey: string | null = null;

    try {
      apiKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: "llm:google",
      });
    } catch {
      // No BYOK key stored, fall through to env var
    }

    if (!apiKey) {
      apiKey = process.env.GOOGLE_AI_API_KEY ?? null;
    }

    if (!apiKey) {
      return withCors(
        new Response(
          JSON.stringify({ error: "No Google AI API key configured. Add one in Settings or contact your administrator." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }

    return withCors(
      new Response(JSON.stringify({ apiKey }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      origin,
    );
  }),
});

// --- Voice-to-Voice (Realtime API) ---

const VOICE_SESSION_RATE_LIMIT = 10; // per minute
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;
const VOICE_LOG_RATE_LIMIT = 120; // per minute
const VOICE_LOG_RATE_WINDOW_MS = 60_000;

http.route({
  path: "/api/voice/session",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/voice/session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "voice_session",
      key: identity.subject,
      limit: VOICE_SESSION_RATE_LIMIT,
      windowMs: VOICE_SESSION_RATE_WINDOW_MS,
      blockMs: VOICE_SESSION_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    type VoiceSessionBody = { conversationId?: string; voice?: string; model?: string };
    let body: VoiceSessionBody | null = null;
    try {
      body = (await request.json()) as VoiceSessionBody;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    // Resolve owner ID from identity
    const ownerId = identity.subject;

    // Conversation ID is optional — local-mode conversations use locally-generated
    // ULIDs (uppercase, digit-prefixed) that aren't valid Convex document IDs.
    // Only attempt ownership verification for IDs that look like Convex IDs
    // (lowercase, no leading digits) to avoid noisy validation errors in logs.
    let convexConversationId: Id<"conversations"> | undefined;
    const rawConvId = body?.conversationId;
    const looksLikeConvexId = rawConvId && /^[a-z]/.test(rawConvId);
    if (looksLikeConvexId) {
      try {
        await requireConversationOwnerAction(ctx, rawConvId as Id<"conversations">);
        convexConversationId = rawConvId as Id<"conversations">;
      } catch {
        // Conversation not found — skip context enrichment
      }
    }

    // Resolve OpenAI API key: BYOK first, then platform key
    let openaiApiKey: string | null = null;
    try {
      openaiApiKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: "llm:openai",
      });
    } catch {
      // BYOK lookup failed — fall through to platform key
    }
    if (!openaiApiKey) {
      openaiApiKey = process.env.OPENAI_API_KEY ?? null;
    }
    if (!openaiApiKey) {
      return withCors(
        new Response(
          JSON.stringify({ error: "No OpenAI API key configured. Add one in Settings or set OPENAI_API_KEY." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }

    // Build voice session instructions with dynamic context
    const { buildVoiceSessionInstructions } = await import("./prompts/voice_orchestrator");
    const { getVoiceToolSchemas } = await import("./tools/voice_schemas");

    // Fetch dynamic context for the instructions
    let deviceStatus: string | undefined;
    let activeThreads: string | undefined;
    let coreMemory: string | undefined;
    let userName: string | undefined;

    try {
      const deviceResult = await ctx.runQuery(
        internal.agent.device_resolver.getDeviceStatus,
        { ownerId },
      );
      const lines = ["# Device Status"];
      lines.push(`- Local device: ${deviceResult.localOnline ? "online" : "offline"}`);
      if (deviceResult.cloudAvailable) {
        lines.push(`- Remote machine: ${deviceResult.cloudStatus}`);
      }
      deviceStatus = lines.join("\n");
    } catch {
      // Skip device status
    }

    try {
      if (!convexConversationId) throw new Error("skip");
      const threads = await ctx.runQuery(internal.data.threads.listActiveThreads, {
        ownerId,
        conversationId: convexConversationId,
      });
      const subagentThreads = (threads as Array<{ _id: string; name: string; messageCount: number }>)
        .filter((t) => t.name !== "Main");
      if (subagentThreads.length > 0) {
        const lines = ["# Active Threads"];
        for (const t of subagentThreads.slice(0, 10)) {
          lines.push(`- ${t.name} (id: ${t._id}, ${t.messageCount} messages)`);
        }
        activeThreads = lines.join("\n");
      }
    } catch {
      // Skip threads
    }

    // Get user profile name if available
    try {
      userName = identity.name ?? identity.nickname ?? undefined;
    } catch {
      // Skip
    }

    const instructions = buildVoiceSessionInstructions({
      userName,
      platform: "desktop",
      deviceStatus,
      activeThreads,
      coreMemory,
    });

    const tools = getVoiceToolSchemas();
    const model = body.model ?? "gpt-realtime-1.5";
    const voice = body.voice ?? "ash";

    // Request ephemeral client secret from OpenAI
    const sessionConfig = {
      model,
      voice,
      instructions,
      tools,
      input_audio_transcription: {
        model: "gpt-4o-transcribe",
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    };

    try {
      const openaiResponse = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sessionConfig),
      });

      const responseText = await openaiResponse.text();
      if (!openaiResponse.ok) {
        console.error("[voice/session] OpenAI sessions failed:", openaiResponse.status, responseText);
        return withCors(
          new Response(
            JSON.stringify({ error: "Failed to create voice session", detail: responseText }),
            { status: openaiResponse.status, headers: { "Content-Type": "application/json" } },
          ),
          origin,
        );
      }

      const openaiData = JSON.parse(responseText);
      return withCors(
        new Response(
          JSON.stringify({
            clientSecret: openaiData.client_secret?.value ?? openaiData.client_secret,
            expiresAt: openaiData.client_secret?.expires_at,
            model,
            voice,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    } catch (error) {
      console.error("[voice/session] Failed to contact OpenAI:", (error as Error).message);
      return withCors(
        new Response(
          JSON.stringify({ error: "Failed to create voice session" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }
  }),
});

// Voice transcript logging endpoint
http.route({
  path: "/api/voice/log",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/voice/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "voice_log",
      key: identity.subject,
      limit: VOICE_LOG_RATE_LIMIT,
      windowMs: VOICE_LOG_RATE_WINDOW_MS,
      blockMs: VOICE_LOG_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    type VoiceLogBody = {
      conversationId: string;
      type: "user_message" | "assistant_message" | "tool_request" | "tool_result";
      content: string;
      metadata?: Record<string, unknown>;
    };
    let body: VoiceLogBody | null = null;
    try {
      body = (await request.json()) as VoiceLogBody;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.conversationId || !body?.type || !body?.content) {
      return withCors(new Response("conversationId, type, and content are required", { status: 400 }), origin);
    }

    const allowedTypes = ["user_message", "assistant_message", "tool_request", "tool_result"];
    if (!allowedTypes.includes(body.type)) {
      return withCors(new Response(`type must be one of: ${allowedTypes.join(", ")}`, { status: 400 }), origin);
    }

    try {
      await requireConversationOwnerAction(ctx, body.conversationId as Id<"conversations">);
    } catch {
      return withCors(new Response("Conversation not found or access denied", { status: 403 }), origin);
    }

    try {
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: body.conversationId as Id<"conversations">,
        type: body.type,
        payload: {
          text: body.content,
          source: "voice",
          ...body.metadata,
        },
      });

      return withCors(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[voice/log] Failed to append event:", (error as Error).message);
      return withCors(
        new Response(JSON.stringify({ error: "Failed to log voice event" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Voice Tool Execution (backend-only tools for realtime voice mode)
// ---------------------------------------------------------------------------

const VOICE_TOOL_RATE_LIMIT = 60;
const VOICE_TOOL_RATE_WINDOW_MS = 60_000;

http.route({
  path: "/api/voice/tool",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/voice/tool",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }
    const ownerId = identity.subject;

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "voice_tool",
      key: ownerId,
      limit: VOICE_TOOL_RATE_LIMIT,
      windowMs: VOICE_TOOL_RATE_WINDOW_MS,
      blockMs: VOICE_TOOL_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    type VoiceToolBody = {
      conversationId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
    };
    let body: VoiceToolBody | null = null;
    try {
      body = (await request.json()) as VoiceToolBody;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.toolName) {
      return withCors(new Response("toolName is required", { status: 400 }), origin);
    }

    const conversationId = (body.conversationId || undefined) as Id<"conversations"> | undefined;
    const args = body.toolArgs ?? {};

    // Verify conversation ownership if provided
    if (conversationId) {
      try {
        await requireConversationOwnerAction(ctx, conversationId);
      } catch {
        return withCors(new Response("Conversation not found or access denied", { status: 403 }), origin);
      }
    }

    try {
      let result: unknown;

      switch (body.toolName) {
        // Memory
        case "RecallMemories":
          result = await ctx.runAction(internal.data.memory.recallMemories, {
            ownerId,
            query: (args.query as string) ?? "",
            source: (args.source as "memory" | "history") ?? undefined,
            conversationId,
          });
          break;

        case "SaveMemory":
          result = await ctx.runAction(internal.data.memory.saveMemory, {
            ownerId,
            content: (args.content as string) ?? "",
            conversationId,
          });
          break;

        // Canvas
        case "OpenCanvas":
          await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId: conversationId!,
            type: "canvas_command",
            payload: {
              action: "open",
              name: (args.name as string) ?? "default",
              title: (args.title as string) ?? (args.name as string) ?? "default",
              url: (args.url as string) ?? undefined,
            },
          });
          result = { ok: true };
          break;

        case "CloseCanvas":
          if (conversationId) {
            await ctx.runMutation(internal.events.appendInternalEvent, {
              conversationId,
              type: "canvas_command",
              payload: { action: "close" },
            });
          }
          result = { ok: true };
          break;

        // Heartbeat
        case "HeartbeatGet":
          result = await ctx.runQuery(internal.scheduling.heartbeat.getConfig, {
            conversationId,
          });
          break;

        case "HeartbeatUpsert":
          result = await ctx.runMutation(internal.scheduling.heartbeat.upsertConfig, {
            conversationId,
            enabled: args.enabled as boolean | undefined,
            intervalMs: args.intervalMs as number | undefined,
            prompt: args.prompt as string | undefined,
            checklist: args.checklist as string | undefined,
            ackMaxChars: args.ackMaxChars as number | undefined,
            deliver: args.deliver as boolean | undefined,
            agentType: args.agentType as string | undefined,
            activeHours: args.activeHours as { start: string; end: string; timezone?: string } | undefined,
            targetDeviceId: args.targetDeviceId as string | undefined,
          });
          break;

        case "HeartbeatRun":
          result = await ctx.runMutation(internal.scheduling.heartbeat.runNow, {
            conversationId,
          });
          break;

        // Cron
        case "CronList":
          result = await ctx.runQuery(internal.scheduling.cron_jobs.list, {});
          break;

        case "CronAdd":
          result = await ctx.runMutation(internal.scheduling.cron_jobs.add, {
            name: args.name as string,
            schedule: args.schedule as { kind: "at"; atMs: number } | { kind: "every"; everyMs: number; anchorMs?: number } | { kind: "cron"; expr: string; tz?: string },
            payload: args.payload as { kind: "systemEvent"; text: string; agentType?: string; deliver?: boolean } | { kind: "agentTurn"; message: string; agentType?: string; deliver?: boolean },
            sessionTarget: (args.sessionTarget as string) ?? "main",
            conversationId,
            description: args.description as string | undefined,
            enabled: args.enabled as boolean | undefined,
            deleteAfterRun: args.deleteAfterRun as boolean | undefined,
          });
          break;

        case "CronUpdate":
          result = await ctx.runMutation(internal.scheduling.cron_jobs.update, {
            jobId: args.jobId as Id<"cron_jobs">,
            patch: args.patch as Record<string, unknown>,
          });
          break;

        case "CronRemove":
          result = await ctx.runMutation(internal.scheduling.cron_jobs.remove, {
            jobId: args.jobId as Id<"cron_jobs">,
          });
          break;

        case "CronRun":
          result = await ctx.runMutation(internal.scheduling.cron_jobs.run, {
            jobId: args.jobId as Id<"cron_jobs">,
          });
          break;

        // Cloud devices
        case "SpawnRemoteMachine":
          result = await ctx.runAction(internal.agent.cloud_devices.spawnForOwner, {
            ownerId,
          });
          break;

        default:
          return withCors(
            new Response(JSON.stringify({ error: `Unknown backend tool: ${body.toolName}` }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
            origin,
          );
      }

      return withCors(
        new Response(JSON.stringify({ result: typeof result === "string" ? result : JSON.stringify(result ?? "OK") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error(`[voice/tool] Failed to execute ${body.toolName}:`, (error as Error).message);
      return withCors(
        new Response(JSON.stringify({ error: `Tool execution failed: ${(error as Error).message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    }
  }),
});

export default http;

