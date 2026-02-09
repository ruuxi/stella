import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { streamText, generateText, createGateway } from "ai";
import { buildSystemPrompt } from "./agent/prompt_builder";
import { createTools } from "./tools/index";
import { resolveModelConfig } from "./agent/model_resolver";
import { authComponent, createAuth, requireConversationOwner } from "./auth";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
} from "./prompts/index";
import { verifyDiscordSignature } from "./channels/discord";
import { verifySlackSignature } from "./channels/slack";
import { verifyGoogleChatJwt } from "./channels/google_chat";
import { verifyTeamsToken } from "./channels/teams";
import { verifyLinqSignature } from "./channels/linq";

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

const WEBHOOK_RATE_WINDOW_MS = 60_000;

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const rateLimitResponse = (retryAfterMs: number) =>
  new Response("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });

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

    const targetDeviceId = userEvent.deviceId ?? undefined;

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

    const agentType =
      body.agent === "self_mod"
        ? "self_mod"
        : body.agent === "general"
          ? "general"
          : "orchestrator";
    const promptBuild = await buildSystemPrompt(ctx, agentType, { ownerId: conversation.ownerId, conversationId });

    // Add platform-specific guidance
    const platformGuidance = getPlatformGuidance(userPlatform);

    const pluginTools = await ctx.runQuery(internal.data.plugins.listToolDescriptorsInternal, {});

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

    const resolvedConfig = await resolveModelConfig(ctx, agentType, conversation.ownerId);
    const result = await streamText({
      ...resolvedConfig,
      system: systemPrompt,
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
          pluginTools: pluginTools as Array<{
            pluginId: string;
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>,
          ownerId: conversation.ownerId,
          conversationId,
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
              await ctx.scheduler.runAfter(0, internal.data.memory.ingestSummary, {
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

const DEFAULT_WELCOME_MESSAGE = "Hey! I'm Stella, your AI assistant. What can I help you with today?";

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
      const synthesisConfig = await resolveModelConfig(ctx, "synthesis", identity.subject);
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

      const welcomeConfig = await resolveModelConfig(ctx, "welcome", identity.subject);
      const welcomePrompt = buildWelcomeMessagePrompt(coreMemory);

      const welcomeModel = typeof welcomeConfig.model === "string"
        ? gateway(welcomeConfig.model)
        : welcomeConfig.model;
      const welcomeResult = await generateText({
        model: welcomeModel,
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

// ---------------------------------------------------------------------------
// Memory Seeding Endpoint (discovery → ephemeral memory)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/seed-memories",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request.headers.get("origin")),
    });
  }),
});

http.route({
  path: "/api/seed-memories",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
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
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

http.route({
  path: "/api/generate-skill-metadata",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
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
// Telegram Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify webhook secret
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret || !secret || !constantTimeEqual(secret, expectedSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: {
      message?: {
        chat?: { id?: number };
        from?: { id?: number; first_name?: string; username?: string };
        text?: string;
        message_id?: number;
      };
    };
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const message = update.message;
    if (!message?.text || !message.chat?.id || !message.from?.id) {
      // Ignore non-text messages (photos, stickers, etc.)
      return new Response("OK", { status: 200 });
    }

    const chatId = String(message.chat.id);
    const telegramUserId = String(message.from.id);
    const text = message.text;
    const displayName = message.from.first_name ?? message.from.username ?? undefined;

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "telegram",
      key: telegramUserId,
      limit: 30,
      windowMs: WEBHOOK_RATE_WINDOW_MS,
      blockMs: WEBHOOK_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfterMs);
    }

    if (text.startsWith("/start")) {
      const codeArg = text.slice("/start".length).trim() || undefined;
      await ctx.scheduler.runAfter(0, internal.channels.telegram.handleStartCommand, {
        chatId,
        telegramUserId,
        codeArg,
        displayName,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.channels.telegram.handleIncomingMessage, {
        chatId,
        telegramUserId,
        text,
        displayName,
      });
    }

    // Return 200 immediately (non-blocking)
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Discord Interactions Endpoint
// ---------------------------------------------------------------------------

// Discord interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;

// Discord interaction response types
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

http.route({
  path: "/api/discord/interactions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      console.error("[discord] Missing DISCORD_PUBLIC_KEY");
      return new Response("Server configuration error", { status: 500 });
    }

    // 1. Ed25519 signature verification
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const rawBody = await request.text();

    if (!signature || !timestamp) {
      return new Response("Missing signature headers", { status: 401 });
    }

    const isValid = await verifyDiscordSignature(rawBody, signature, timestamp, publicKey);
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    // 2. Parse the interaction
    let interaction: {
      type: number;
      id: string;
      token: string;
      application_id: string;
      data?: {
        name?: string;
        options?: Array<{ name: string; value: string }>;
      };
      user?: { id: string; username?: string; global_name?: string };
      member?: { user?: { id: string; username?: string; global_name?: string } };
    };
    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 3. Handle PING (Discord verification check)
    if (interaction.type === INTERACTION_PING) {
      return new Response(JSON.stringify({ type: RESPONSE_PONG }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Handle slash commands
    if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
      const commandName = interaction.data?.name;
      const options = interaction.data?.options ?? [];
      // User can be top-level (DM) or nested under member (guild)
      const user = interaction.user ?? interaction.member?.user;
      const discordUserId = user?.id ?? "";
      const displayName = user?.global_name ?? user?.username ?? undefined;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      if (commandName === "status") {
        // Status is fast enough to respond immediately
        const connection = discordUserId
          ? await ctx.runQuery(internal.channels.utils.getConnectionByProviderAndExternalId, {
              provider: "discord",
              externalUserId: discordUserId,
            })
          : null;

        const statusText = connection
          ? `Connected to Stella (linked ${new Date(connection.linkedAt).toLocaleDateString()}). Use \`/ask\` to chat.`
          : "Not linked. Use `/link` with your 6-digit code from Stella Settings.";

        return new Response(
          JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE, data: { content: statusText } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (commandName === "link") {
        const codeArg = options.find((o) => o.name === "code")?.value ?? "";

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "discord",
          key: `${discordUserId}:link`,
          limit: 30,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        // Defer response (shows "thinking...")
        // Schedule the actual work as an internal action
        await ctx.scheduler.runAfter(0, internal.channels.discord.handleLinkCommand, {
          applicationId,
          interactionToken,
          discordUserId,
          codeArg,
          displayName,
        });

        return new Response(
          JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (commandName === "ask") {
        const message = options.find((o) => o.name === "message")?.value ?? "";

        if (!message.trim()) {
          return new Response(
            JSON.stringify({
              type: RESPONSE_CHANNEL_MESSAGE,
              data: { content: "Please provide a message. Usage: `/ask your question here`" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "discord",
          key: `${discordUserId}:ask`,
          limit: 20,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        // Defer response and process async
        await ctx.scheduler.runAfter(0, internal.channels.discord.handleAskCommand, {
          applicationId,
          interactionToken,
          discordUserId,
          text: message,
          displayName,
        });

        return new Response(
          JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Unknown command
      return new Response(
        JSON.stringify({
          type: RESPONSE_CHANNEL_MESSAGE,
          data: { content: "Unknown command." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Unhandled interaction type
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Slack OAuth Callback
// ---------------------------------------------------------------------------

const buildSlackResultPage = (success: boolean, message: string): string => {
  const title = success ? "Stella Installed" : "Installation Failed";
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { text-align: center; padding: 3rem; max-width: 400px; }
  .icon { font-size: 4rem; color: ${color}; margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #a3a3a3; line-height: 1.6; }
</style>
</head>
<body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
};

http.route({
  path: "/api/slack/oauth_callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      return new Response(buildSlackResultPage(false, "Installation was cancelled."), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (!code) {
      return new Response(buildSlackResultPage(false, "Missing authorization code."), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error("[slack-oauth] Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET");
      return new Response(buildSlackResultPage(false, "Server configuration error."), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    try {
      const redirectUri = `${process.env.CONVEX_SITE_URL}/api/slack/oauth_callback`;
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      const tokenData = await tokenRes.json() as {
        ok: boolean;
        error?: string;
        access_token?: string;
        bot_user_id?: string;
        scope?: string;
        team?: { id?: string; name?: string };
        authed_user?: { id?: string };
      };

      if (!tokenData.ok) {
        console.error("[slack-oauth] Token exchange failed:", tokenData.error);
        return new Response(
          buildSlackResultPage(false, `Slack error: ${tokenData.error}`),
          { status: 400, headers: { "Content-Type": "text/html" } },
        );
      }

      await ctx.runMutation(internal.channels.slack_installations.upsert, {
        teamId: tokenData.team?.id ?? "",
        teamName: tokenData.team?.name,
        botToken: tokenData.access_token ?? "",
        botUserId: tokenData.bot_user_id,
        scope: tokenData.scope,
        installedBy: tokenData.authed_user?.id,
      });

      const teamName = tokenData.team?.name ?? "your workspace";
      return new Response(
        buildSlackResultPage(true, `Stella has been installed in ${teamName}! You can close this tab and DM @Stella to get started.`),
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      console.error("[slack-oauth] Error:", err);
      return new Response(
        buildSlackResultPage(false, "An unexpected error occurred during installation."),
        { status: 500, headers: { "Content-Type": "text/html" } },
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Slack Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/slack",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      console.error("[slack] Missing SLACK_SIGNING_SECRET");
      return new Response("Server configuration error", { status: 500 });
    }

    const rawBody = await request.text();
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";

    const isValid = await verifySlackSignature(rawBody, timestamp, signature, signingSecret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: {
      type?: string;
      challenge?: string;
      team_id?: string;
      event?: {
        type?: string;
        bot_id?: string;
        channel_type?: string;
        text?: string;
        user?: string;
        channel?: string;
      };
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Handle URL verification challenge (Slack setup requirement)
    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle event callbacks
    if (payload.type === "event_callback") {
      const event = payload.event;

      // Only handle DMs (im) that aren't from bots
      if (event?.type === "message" && !event.bot_id && event.channel_type === "im") {
        const text = (event.text ?? "").trim();
        const slackUserId = event.user;
        const channelId = event.channel;
        if (!slackUserId || !channelId) {
          return new Response("OK", { status: 200 });
        }

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "slack",
          key: slackUserId,
          limit: 30,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        if (text.toLowerCase().startsWith("link ")) {
          await ctx.scheduler.runAfter(0, internal.channels.slack.handleLinkCommand, {
            slackUserId,
            channelId,
            code: text.slice(5).trim(),
            teamId: payload.team_id,
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.channels.slack.handleIncomingMessage, {
            slackUserId,
            channelId,
            text,
            teamId: payload.team_id,
          });
        }
      }
    }

    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Google Chat Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/google_chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER;
    if (!projectNumber) {
      console.error("[google_chat] Missing GOOGLE_CHAT_PROJECT_NUMBER");
      return new Response("Server configuration error", { status: 500 });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const isValid = await verifyGoogleChatJwt(authHeader, projectNumber);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let event: {
      type?: string;
      message?: {
        sender?: { name?: string; displayName?: string };
        argumentText?: string;
        text?: string;
      };
      space?: { name?: string };
    };
    try {
      event = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (event.type === "MESSAGE") {
      const text = (event.message?.argumentText ?? event.message?.text ?? "").trim();
      const senderName = event.message?.sender?.name ?? "";
      // Google Chat sender name format: "users/123456"
      const googleUserId = senderName.startsWith("users/") ? senderName.slice(6) : senderName;
      const displayName = event.message?.sender?.displayName;
      const spaceName = event.space?.name ?? "";

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "google_chat",
        key: googleUserId || "unknown",
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      if (text.toLowerCase().startsWith("link ")) {
        await ctx.scheduler.runAfter(0, internal.channels.google_chat.handleLinkCommand, {
          spaceName,
          googleUserId,
          code: text.slice(5).trim(),
          displayName,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.channels.google_chat.handleIncomingMessage, {
          spaceName,
          googleUserId,
          text,
          displayName,
        });
      }
    }

    // Return empty response (async processing)
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Microsoft Teams Webhook (Bot Framework)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/teams",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const appId = process.env.TEAMS_APP_ID;
    if (!appId) {
      console.error("[teams] Missing TEAMS_APP_ID");
      return new Response("Server configuration error", { status: 500 });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const isValid = await verifyTeamsToken(authHeader, appId);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let activity: {
      type?: string;
      text?: string;
      from?: { aadObjectId?: string; id?: string; name?: string };
      serviceUrl?: string;
      conversation?: { id?: string };
    };
    try {
      activity = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (activity.type === "message" && activity.text) {
      // Strip @mentions (Teams wraps them in <at>...</at>)
      const text = (activity.text ?? "").replace(/<at>.*?<\/at>/g, "").trim();
      const teamsUserId = activity.from?.aadObjectId ?? activity.from?.id ?? "";
      const displayName = activity.from?.name;
      const serviceUrl = activity.serviceUrl ?? "";
      const conversationId = activity.conversation?.id ?? "";

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "teams",
        key: teamsUserId || "unknown",
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      if (text.toLowerCase().startsWith("link ")) {
        await ctx.scheduler.runAfter(0, internal.channels.teams.handleLinkCommand, {
          serviceUrl,
          conversationIdTeams: conversationId,
          teamsUserId,
          code: text.slice(5).trim(),
          displayName,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.channels.teams.handleIncomingMessage, {
          serviceUrl,
          conversationIdTeams: conversationId,
          teamsUserId,
          text,
          displayName,
        });
      }
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Linq Webhook (iMessage/RCS/SMS via Linq Partner API)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/linq",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("[linq] Missing LINQ_WEBHOOK_SECRET");
      return new Response("Server configuration error", { status: 500 });
    }

    const signature = request.headers.get("x-webhook-signature") ?? "";
    const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
    const rawBody = await request.text();

    const isValid = await verifyLinqSignature(rawBody, signature, timestamp, webhookSecret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let envelope: {
      event_type?: string;
      data?: {
        chat?: { id?: string; is_group?: boolean; owner_handle?: { handle?: string } };
        sender_handle?: { handle?: string };
        parts?: Array<{ type?: string; value?: string }>;
      };
    };
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Only handle incoming messages
    if (envelope.event_type !== "message.received") {
      return new Response("OK", { status: 200 });
    }

    const senderPhone = envelope.data?.sender_handle?.handle ?? "";
    const fromNumber = process.env.LINQ_FROM_NUMBER ?? "";
    const isGroup = envelope.data?.chat?.is_group ?? false;

    // Skip self-messages (our own outgoing messages echoed back)
    if (!senderPhone || senderPhone === fromNumber) {
      return new Response("OK", { status: 200 });
    }

    // Extract text from message parts
    const parts = envelope.data?.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.value ?? "")
      .join("\n")
      .trim();

    if (!text) {
      return new Response("OK", { status: 200 });
    }

    const incomingChatId = envelope.data?.chat?.id ?? "";

    // Rate limit
    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "linq",
      key: senderPhone,
      limit: 30,
      windowMs: WEBHOOK_RATE_WINDOW_MS,
      blockMs: WEBHOOK_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      console.log("[linq] Rate limited:", senderPhone);
      return rateLimitResponse(rateLimit.retryAfterMs);
    }

    console.log("[linq] Dispatching message from", senderPhone, "text:", text.slice(0, 100), "chatId:", incomingChatId);

    // Detect link code: bare 6-digit alphanumeric code, or "link CODE"
    const linkPrefix = text.toLowerCase().startsWith("link ") ? text.slice(5).trim() : text.trim();
    const isLinkCode = /^[A-Z0-9]{6}$/i.test(linkPrefix);

    if (isLinkCode) {
      await ctx.scheduler.runAfter(0, internal.channels.linq.handleStartCommand, {
        senderPhone,
        text: linkPrefix,
        incomingChatId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.channels.linq.handleIncomingMessage, {
        senderPhone,
        text,
        incomingChatId,
        groupId: isGroup ? incomingChatId : undefined,
      });
    }

    console.log("[linq] Handler scheduled, returning 200");
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Bridge Poll Endpoint (bridge.js polls for outbound replies)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/bridge/poll",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = request.headers.get("x-bridge-secret") ?? "";

    let body: { provider?: string; ownerId?: string };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.ownerId || !body.provider) {
      return new Response("Invalid payload", { status: 400 });
    }

    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: body.ownerId,
      provider: body.provider,
    });
    if (!session || !constantTimeEqual(secret, session.webhookSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const messages = await ctx.runMutation(internal.channels.bridge_outbound.claim, {
      sessionId: session._id,
    });

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Bridge Webhook (WhatsApp, Signal — persistent processes in Sprites)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/bridge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = request.headers.get("x-bridge-secret") ?? "";

    let payload: {
      type: string;
      provider?: string;
      ownerId?: string;
      externalUserId?: string;
      text?: string;
      displayName?: string;
      replyCallback?: string;
      authState?: unknown;
      status?: string;
      error?: string;
    };
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!payload.ownerId || !payload.provider) {
      return new Response("Invalid payload", { status: 400 });
    }

    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: payload.ownerId,
      provider: payload.provider,
    });
    if (!session || !constantTimeEqual(secret, session.webhookSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (payload.type === "heartbeat") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:heartbeat`,
        limit: 120,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleHeartbeat, {
        ownerId: payload.ownerId,
        provider: payload.provider,
      });
    } else if (payload.type === "auth_update") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:auth`,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleAuthUpdate, {
        ownerId: payload.ownerId,
        provider: payload.provider,
        authState: payload.authState ?? {},
        status: payload.status ?? "awaiting_auth",
      });
    } else if (payload.type === "message") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:${payload.externalUserId ?? "unknown"}`,
        limit: 40,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleBridgeMessage, {
        provider: payload.provider,
        ownerId: payload.ownerId,
        externalUserId: payload.externalUserId ?? "",
        text: payload.text ?? "",
        displayName: payload.displayName,
      });
    } else if (payload.type === "error") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:error`,
        limit: 20,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleBridgeError, {
        ownerId: payload.ownerId,
        provider: payload.provider,
        error: payload.error ?? "Unknown error",
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

export default http;
