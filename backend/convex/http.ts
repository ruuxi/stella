import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { streamText } from "ai";
import {
  GENERAL_AGENT_SYSTEM_PROMPT,
  SELF_MOD_AGENT_SYSTEM_PROMPT,
} from "./prompts";

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

    const userText =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string }).text ?? ""
        : "";

    const attachments = body.attachments ?? [];
    const attachmentSummary =
      attachments.length > 0
        ? `\n\nAttachments:\n${attachments
            .map((attachment) => {
              const label = attachment.url ?? attachment.id ?? "attachment";
              return `- ${label}`;
            })
            .join("\n")}`
        : "";

    const systemPrompt =
      body.agent === "self_mod"
        ? SELF_MOD_AGENT_SYSTEM_PROMPT
        : GENERAL_AGENT_SYSTEM_PROMPT;

    const model = process.env.AI_GATEWAY_MODEL;
    if (!model) {
      return withCors(
        new Response("AI gateway model not configured", { status: 500 }),
        origin,
      );
    }

    const result = await streamText({
      model,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `${userText}${attachmentSummary}`.trim(),
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
