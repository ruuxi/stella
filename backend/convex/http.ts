import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { streamText, generateText, createGateway } from "ai";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "./tools";
import { getModelConfig } from "./model";
import { authComponent, createAuth, requireConversationOwner } from "./auth";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
} from "./prompts";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "orchestrator" | "general" | "self_mod";
};

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd //c start <app>\` (NOT \`open -a\`)
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

const HISTORY_LIMIT = 100;

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

const getCorsHeaders = (origin: string | null) => {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } as Record<string, string>;
};

const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

http.route({
  path: "/api/chat",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

http.route({
  path: "/api/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
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
      conversation = await requireConversationOwner(ctx, conversationId);
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

    const targetDeviceId = userEvent.deviceId;
    if (!targetDeviceId) {
      return withCors(
        new Response("User message is missing deviceId", { status: 400 }),
        origin,
      );
    }

    const userPayload =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string; platform?: string })
        : {};
    const userText = userPayload.text ?? "";
    const userPlatform = userPayload.platform ?? "unknown";

    const historyLimit = Math.max(0, HISTORY_LIMIT - 1);
    const historyEvents =
      historyLimit > 0
        ? await ctx.runQuery(internal.events.listRecentMessages, {
            conversationId,
            limit: historyLimit,
            beforeTimestamp: userEvent.timestamp,
            excludeEventId: userMessageId,
          })
        : [];

    const historyMessages = historyEvents.flatMap((event: Doc<"events">) => {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { text?: string })
          : {};
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        return [];
      }
      return [
        {
          role: event.type === "assistant_message" ? ("assistant" as const) : ("user" as const),
          content: text,
        },
      ];
    });

    const attachments = body.attachments ?? [];
    const resolvedImages: Array<{ url: string; mimeType?: string }> = [];
    for (const attachment of attachments) {
      if (attachment.id) {
        const record = await ctx.runQuery(internal.attachments.getById, {
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

    await ctx.runMutation(api.agents.ensureBuiltins, {});

    const agentType =
      body.agent === "self_mod"
        ? "self_mod"
        : body.agent === "general"
          ? "general"
          : "orchestrator";
    const promptBuild = await buildSystemPrompt(ctx, agentType, { ownerId: conversation.ownerId });

    // Add platform-specific guidance
    const platformGuidance = getPlatformGuidance(userPlatform);

    const pluginTools = await ctx.runQuery(api.plugins.listToolDescriptors, {});

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

    // Combine system prompt with platform guidance
    const systemPrompt = platformGuidance
      ? `${promptBuild.systemPrompt}\n\n${platformGuidance}`
      : promptBuild.systemPrompt;

    const result = await streamText({
      ...getModelConfig(agentType),
      system: systemPrompt,
      tools: createTools(
        ctx,
        {
          conversationId,
          userMessageId,
          targetDeviceId,
          agentType,
          sourceDeviceId: userEvent.deviceId,
        },
        {
          agentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools: pluginTools as Array<{
            pluginId: string;
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>,
          ownerId: conversation.ownerId,
        },
      ),
      messages: [
        ...historyMessages,
        {
          role: "user",
          content: contentParts,
        },
      ],
      abortSignal: request.signal,
      onFinish: async ({ text, usage, totalUsage }) => {
        if (text.trim().length > 0) {
          const usageTotals = totalUsage ?? usage;
          const hasUsage =
            usageTotals &&
            (typeof usageTotals.inputTokens === "number" ||
              typeof usageTotals.outputTokens === "number" ||
              typeof usageTotals.totalTokens === "number");
          const usageSummary = hasUsage
            ? {
                inputTokens: usageTotals.inputTokens,
                outputTokens: usageTotals.outputTokens,
                totalTokens: usageTotals.totalTokens,
              }
            : undefined;
          await ctx.runMutation(internal.events.saveAssistantMessage, {
            conversationId,
            text,
            userMessageId,
            usage: usageSummary,
          });
        }

        // Track cumulative token usage on conversation
        const usageTotals = totalUsage ?? usage;
        const totalTokens = usageTotals?.totalTokens ?? 0;
        if (totalTokens > 0) {
          await ctx.runMutation(internal.conversations.patchTokenCount, {
            conversationId,
            tokenDelta: totalTokens,
          });
        }

        // Check if current context size exceeds 50k input tokens.
        // Use the larger of last-step vs total usage for safety.
        const inputTokens = Math.max(usage?.inputTokens ?? 0, totalUsage?.inputTokens ?? 0);
        if (inputTokens > 50_000) {
          const oldestHistoryTimestamp =
            historyEvents.length > 0
              ? historyEvents[0]?.timestamp ?? Date.now()
              : Date.now();
          try {
            const olderEvents = await ctx.runQuery(
              internal.events.listOlderMessages,
              {
                conversationId,
                beforeTimestamp: oldestHistoryTimestamp,
                // Skip events already ingested in a previous run
                afterTimestamp: conversation.lastIngestedAt ?? undefined,
                limit: 50,
              },
            );
            if (olderEvents.length > 0) {
              const latestTimestamp = olderEvents[olderEvents.length - 1]?.timestamp ?? Date.now();
              // Schedule ingestion as a separate job so it runs independently
              await ctx.scheduler.runAfter(0, internal.memory.ingestSummary, {
                conversationId,
                ownerId: conversation.ownerId,
                ingestedThroughTimestamp: latestTimestamp,
                events: olderEvents.map((e: any) => ({
                  type: e.type as string,
                  text:
                    (e.payload &&
                      typeof e.payload === "object" &&
                      (e.payload as { text?: string }).text) ??
                    "",
                })),
              });
            }
          } catch {
            // Ingestion failure should not affect the chat response
          }
        }
      },
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
};

const DEFAULT_WELCOME_MESSAGE = "Hey! I'm Stellar, your AI assistant. What can I help you with today?";

http.route({
  path: "/api/synthesize",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

http.route({
  path: "/api/synthesize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
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
      const synthesisConfig = getModelConfig("synthesis");
      const userMessage = buildCoreSynthesisUserMessage(body.formattedSignals);

      const synthesisResult = await generateText({
        model: gateway(synthesisConfig.model),
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

      const welcomeConfig = getModelConfig("welcome");
      const welcomePrompt = buildWelcomeMessagePrompt(coreMemory);

      const welcomeResult = await generateText({
        model: gateway(welcomeConfig.model),
        messages: [{ role: "user", content: welcomePrompt }],
        maxOutputTokens: welcomeConfig.maxOutputTokens,
        temperature: welcomeConfig.temperature,
        providerOptions: welcomeConfig.providerOptions,
      });

      const response: SynthesizeResponse = {
        coreMemory,
        welcomeMessage: welcomeResult.text?.trim() || DEFAULT_WELCOME_MESSAGE,
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

export default http;
