import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { streamText } from "ai";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "./tools";
import { getModelConfig } from "./model";
import { authComponent, createAuth, requireConversationOwner } from "./auth";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "general" | "self_mod";
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

const HISTORY_LIMIT = 20;

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

    const agentType = body.agent === "self_mod" ? "self_mod" : "general";
    const promptBuild = await buildSystemPrompt(ctx, agentType);

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
      onFinish: async ({ text }) => {
        await ctx.runMutation(internal.events.saveAssistantMessage, {
          conversationId,
          text,
          userMessageId,
        });
      },
    });

    const response = result.toUIMessageStreamResponse();
    return withCors(response, origin);
  }),
});

export default http;
