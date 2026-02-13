/**
 * Command Suggestion System
 *
 * After each assistant response, a lightweight LLM suggests 0-3 commands
 * the user might want to run next based on conversation context.
 */

import { v } from "convex/values";
import { generateText } from "ai";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { resolveModelConfig } from "./model_resolver";

type Suggestion = {
  commandId: string;
  name: string;
  description: string;
};

const SUGGESTION_PROMPT = `Based on the recent conversation, suggest 0-3 commands the user might want to run next.
Only suggest commands that are clearly relevant to the conversation context. Return an empty array if nothing fits.

## Available Commands
{catalog}

## Recent Conversation
{messages}

Return ONLY a JSON array (no markdown fences). Each element: {"commandId": "...", "name": "...", "description": "..."}
If no commands are relevant, return: []`;

export const generateSuggestions = internalAction({
  args: {
    conversationId: v.id("conversations"),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // 1. Load command catalog
    const catalog = await ctx.runQuery(internal.data.commands.listCatalog, {});
    if (catalog.length === 0) return null;

    // 2. Load recent messages (small token budget)
    const events = await ctx.runQuery(
      internal.events.listRecentContextEventsByTokens,
      {
        conversationId: args.conversationId,
        maxTokens: 4000,
      },
    );

    // Build a compact message summary
    const messageParts: string[] = [];
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (event.type === "user_message") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text) messageParts.push(`User: ${text.slice(0, 500)}`);
      } else if (event.type === "assistant_message") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text) messageParts.push(`Assistant: ${text.slice(0, 500)}`);
      }
    }

    if (messageParts.length === 0) return null;

    // 3. Build catalog text
    const catalogText = catalog
      .map((c) => `${c.commandId}: ${c.name} - ${c.description}`)
      .join("\n");

    // 4. Build prompt
    const prompt = SUGGESTION_PROMPT
      .replace("{catalog}", catalogText)
      .replace("{messages}", messageParts.join("\n"));

    // 5. Call lightweight LLM
    try {
      const resolvedConfig = await resolveModelConfig(ctx, "suggestions", args.ownerId);

      const result = await generateText({
        ...resolvedConfig,
        messages: [{ role: "user", content: prompt }],
      });

      const text = result.text?.trim() ?? "";
      if (!text || text === "[]") return null;

      // Parse JSON response
      let suggestions: Suggestion[];
      try {
        // Strip markdown fences if present
        const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) return null;

        suggestions = parsed
          .filter(
            (s: unknown): s is Suggestion =>
              typeof s === "object" &&
              s !== null &&
              typeof (s as Suggestion).commandId === "string" &&
              typeof (s as Suggestion).name === "string",
          )
          .slice(0, 3);
      } catch {
        return null;
      }

      if (suggestions.length === 0) return null;

      // 6. Emit command_suggestions event
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "command_suggestions",
        payload: { suggestions },
      });
    } catch (error) {
      console.error("Suggestion generation failed:", (error as Error).message);
    }

    return null;
  },
});

