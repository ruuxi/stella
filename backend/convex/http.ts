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

http.route({
  path: "/api/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: ChatRequest | null = null;
    try {
      body = (await request.json()) as ChatRequest;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body?.conversationId || !body?.userMessageId) {
      return new Response("conversationId and userMessageId are required", {
        status: 400,
      });
    }

    const conversationId = body.conversationId as Id<"conversations">;
    const userMessageId = body.userMessageId as Id<"events">;

    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: conversationId,
    });
    if (!conversation) {
      return new Response("Conversation not found", { status: 404 });
    }

    const userEvent = await ctx.runQuery(internal.events.getById, {
      id: userMessageId,
    });
    if (!userEvent || userEvent.type !== "user_message") {
      return new Response("User message not found", { status: 404 });
    }

    if (userEvent.conversationId !== conversationId) {
      return new Response("Conversation mismatch", { status: 400 });
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
      return new Response("AI gateway model not configured", { status: 500 });
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

    return result.toUIMessageStreamResponse();
  }),
});

export default http;
