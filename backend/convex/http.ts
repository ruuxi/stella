import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { streamText } from "ai";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "./tools";
import { getModelConfig } from "./model";

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

const HISTORY_LIMIT = 20;

const http = httpRouter();

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

    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: conversationId,
    });
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

    const userText =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string }).text ?? ""
        : "";

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

    const result = await streamText({
      ...getModelConfig(agentType),
      system: promptBuild.systemPrompt,
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
