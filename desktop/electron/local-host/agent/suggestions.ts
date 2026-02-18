/**
 * Local command suggestion system.
 * Ported from backend/convex/agent/suggestions.ts
 */

import { generateText } from "ai";
import { rawQuery } from "../db";
import { insert } from "../db";
import { broadcastSSE } from "../server";
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

export async function generateSuggestions(
  conversationId: string,
  ownerId: string,
): Promise<void> {
  try {
    // Load command catalog
    const catalog = rawQuery<{
      command_id: string;
      name: string;
      description: string;
    }>("SELECT command_id, name, description FROM commands WHERE enabled = 1", []);

    if (catalog.length === 0) return;

    // Load recent messages
    const events = rawQuery<{
      type: string;
      payload: string | Record<string, unknown>;
    }>(
      "SELECT type, payload FROM events WHERE conversation_id = ? AND type IN ('user_message', 'assistant_message') ORDER BY timestamp DESC LIMIT 10",
      [conversationId],
    );

    const messageParts: string[] = [];
    for (const event of events) {
      const payload = typeof event.payload === "string"
        ? JSON.parse(event.payload) as Record<string, unknown>
        : event.payload;
      const text = typeof payload?.text === "string" ? payload.text : "";
      if (!text) continue;
      const role = event.type === "assistant_message" ? "Assistant" : "User";
      messageParts.push(`${role}: ${text.slice(0, 500)}`);
    }

    if (messageParts.length === 0) return;

    // Build prompt
    const catalogText = catalog
      .map((c) => `${c.command_id}: ${c.name} - ${c.description}`)
      .join("\n");

    const prompt = SUGGESTION_PROMPT
      .replace("{catalog}", catalogText)
      .replace("{messages}", messageParts.reverse().join("\n"));

    // Call LLM
    const resolvedConfig = resolveModelConfig("suggestions", ownerId);
    const result = await generateText({
      ...resolvedConfig,
      messages: [{ role: "user", content: prompt }],
    });

    const text = result.text?.trim() ?? "";
    if (!text || text === "[]") return;

    // Parse response
    let suggestions: Suggestion[];
    try {
      const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return;

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
      return;
    }

    if (suggestions.length === 0) return;

    // Save as event and broadcast via SSE
    const now = Date.now();
    insert("events", {
      conversation_id: conversationId,
      timestamp: now,
      type: "command_suggestions",
      payload: JSON.stringify({ suggestions }),
    });

    broadcastSSE(conversationId, "suggestions", { suggestions });
  } catch (error) {
    console.error("[suggestions] Generation failed:", (error as Error).message);
  }
}
