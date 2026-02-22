import { v } from "convex/values";
import { generateText } from "ai";
import {
  internalAction,
  internalMutation,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { asPlainObjectRecord } from "../lib/object_utils";
import { getModelConfig } from "../agent/model";

const MAX_SESSION_EVENTS_FOR_SUMMARY = 5_000;
const MAX_LINE_CHARS = 1_000;

const SESSION_COMPACTION_SUMMARY_PROMPT = `You summarize a completed orchestrator session for future recall.

Return concise markdown with these sections:
1. What the user wanted
2. Key outcomes and decisions
3. Important facts/preferences learned
4. Open loops / follow-ups

Rules:
- Stay factual and avoid speculation.
- Preserve concrete details (names, files, commands, dates, constraints).
- Keep it dense and useful for future retrieval.
- Maximum length: 900 words.
- Do not include JSON.`;

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
};

const extractEventLine = (event: {
  type: string;
  timestamp: number;
  payload: unknown;
}) => {
  const payload = asPlainObjectRecord<unknown>(event.payload);
  const timestamp = new Date(event.timestamp).toISOString();
  if (event.type === "user_message" || event.type === "assistant_message") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    return `[${timestamp}] ${event.type}: ${truncate(text, MAX_LINE_CHARS)}`;
  }
  if (event.type === "task_completed") {
    const result = payload.result;
    const text = typeof result === "string" ? result.trim() : "";
    if (!text) return null;
    return `[${timestamp}] task_completed: ${truncate(text, MAX_LINE_CHARS)}`;
  }
  if (event.type === "task_failed") {
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    if (!error) return null;
    return `[${timestamp}] task_failed: ${truncate(error, MAX_LINE_CHARS)}`;
  }
  return null;
};

export const setSessionCompactionResult = internalMutation({
  args: {
    sessionId: v.id("conversation_sessions"),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return null;
    }
    await ctx.db.patch(args.sessionId, {
      compactionStatus: args.status,
      compactionSummary: args.summary,
      compactionError: args.error,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const generateSessionCompactionSummary = internalAction({
  args: {
    sessionId: v.id("conversation_sessions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.conversations.getSessionById, {
      sessionId: args.sessionId,
    });
    if (!session || !session.closedAt) {
      return null;
    }
    if (
      session.compactionStatus === "ready" &&
      typeof session.compactionSummary === "string" &&
      session.compactionSummary.trim().length > 0
    ) {
      return null;
    }

    await ctx.runMutation(internal.data.session_compaction.setSessionCompactionResult, {
      sessionId: args.sessionId,
      status: "pending",
      summary: undefined,
      error: undefined,
    });

    try {
      const events = await ctx.runQuery(internal.events.listEventsForSession, {
        conversationId: session.conversationId,
        sessionId: args.sessionId,
        limit: MAX_SESSION_EVENTS_FOR_SUMMARY,
      });

      const lines = events
        .map((event) =>
          extractEventLine({
            type: event.type,
            timestamp: event.timestamp,
            payload: event.payload,
          }))
        .filter((line): line is string => !!line);

      const summarySource = lines.length > 0
        ? lines.join("\n")
        : "No user/assistant/task content recorded in this session.";

      const config = getModelConfig("session_compaction_summary");
      const { text } = await generateText({
        ...config,
        system: SESSION_COMPACTION_SUMMARY_PROMPT,
        messages: [{ role: "user", content: summarySource }],
      });

      const summary = text.trim();
      if (!summary) {
        throw new Error("LLM returned empty compaction summary.");
      }
      const summaryWithSource = [
        summary,
        "",
        `sourceConversationId=${session.conversationId}`,
        `sourceSessionId=${args.sessionId}`,
      ].join("\n");

      await ctx.runMutation(internal.data.session_compaction.setSessionCompactionResult, {
        sessionId: args.sessionId,
        status: "ready",
        summary: summaryWithSource,
        error: undefined,
      });
    } catch (error) {
      const message = (error as Error).message || "Failed to generate compaction summary.";
      await ctx.runMutation(internal.data.session_compaction.setSessionCompactionResult, {
        sessionId: args.sessionId,
        status: "error",
        summary: undefined,
        error: message,
      });
    }

    return null;
  },
});
