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
  if (event.type === "tool_request") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
    const args = payload.args ? JSON.stringify(payload.args) : "{}";
    return `[${timestamp}] tool_request: ${toolName}(${truncate(args, MAX_LINE_CHARS)})`;
  }
  if (event.type === "tool_result") {
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
    const result = typeof payload.result === "string" ? payload.result.trim() : JSON.stringify(payload.result);
    return `[${timestamp}] tool_result: ${toolName} => ${truncate(result, MAX_LINE_CHARS)}`;
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

const CHUNK_MAX_CHARS = 40_000;

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

      if (lines.length === 0) {
        await ctx.runMutation(internal.data.session_compaction.setSessionCompactionResult, {
          sessionId: args.sessionId,
          status: "ready",
          summary: "No user/assistant/task content recorded in this session.",
          error: undefined,
        });
        return null;
      }

      // Group lines into chunks by CHUNK_MAX_CHARS
      const chunks: string[] = [];
      let currentChunk: string[] = [];
      let currentLength = 0;

      for (const line of lines) {
        if (currentLength + line.length > CHUNK_MAX_CHARS && currentChunk.length > 0) {
          chunks.push(currentChunk.join("\n"));
          currentChunk = [];
          currentLength = 0;
        }
        currentChunk.push(line);
        currentLength += line.length + 1; // +1 for newline
      }
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"));
      }

      const config = getModelConfig("session_compaction_summary");
      
      let finalSummary = "";

      // Process chunks sequentially or in parallel depending on desired behavior
      // Here we process sequentially, building up a final summary
      if (chunks.length === 1) {
        const { text } = await generateText({
          ...config,
          system: SESSION_COMPACTION_SUMMARY_PROMPT,
          messages: [{ role: "user", content: chunks[0] }],
        });
        finalSummary = text.trim();
      } else {
         let cumulativeSummary = "";
         for (let i = 0; i < chunks.length; i++) {
            const promptBody = cumulativeSummary
              ? `Previous summary part:\n${cumulativeSummary}\n\nNew events to incorporate:\n${chunks[i]}`
              : chunks[i];

            const { text } = await generateText({
              ...config,
              system: SESSION_COMPACTION_SUMMARY_PROMPT,
              messages: [{ role: "user", content: promptBody }],
            });
            cumulativeSummary = text.trim();
         }
         finalSummary = cumulativeSummary;
      }

      if (!finalSummary) {
        throw new Error("LLM returned empty compaction summary.");
      }
      const summaryWithSource = [
        finalSummary,
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
