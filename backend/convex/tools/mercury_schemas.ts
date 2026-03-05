/**
 * Mercury tool schemas for AI SDK generateText.
 *
 * Mercury is a fast routing layer (Inception Labs mercury-2) that handles
 * voice requests by either resolving them directly (search, dashboard control,
 * HTML generation) or fire-and-forgetting complex tasks to the orchestrator.
 */
import { z } from "zod";
import { tool } from "ai";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

export type MercuryToolResult = {
  action: string;
  spoken_summary?: string;
  query?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
  title?: string;
  html?: string;
  operation?: string;
  window_type?: string;
};

export function createMercuryTools(ctx: ActionCtx, conversationId?: string) {
  return {
    search: tool({
      description:
        "Search the web for current information. Use when the user asks to find, look up, or search for something.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
        spoken_summary: z
          .string()
          .describe("Brief spoken response for the user, e.g. 'Let me search for that'"),
      }),
      execute: async (args) => {
        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
          return {
            action: "show_search",
            spoken_summary: args.spoken_summary,
            query: args.query,
            results: [],
          };
        }

        try {
          const response = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: args.query,
              type: "auto",
              numResults: 6,
              contents: { text: { maxCharacters: 1000 } },
            }),
          });

          if (!response.ok) {
            return { action: "show_search", spoken_summary: args.spoken_summary, query: args.query, results: [] };
          }

          const data = await response.json();
          const results = (data.results ?? []).map(
            (r: { title?: string; url?: string; text?: string }) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: (r.text ?? "").slice(0, 300),
            }),
          );

          return { action: "show_search", spoken_summary: args.spoken_summary, query: args.query, results };
        } catch {
          return { action: "show_search", spoken_summary: args.spoken_summary, query: args.query, results: [] };
        }
      },
    }),

    open_dashboard: tool({
      description:
        "Open/show the Neri dashboard overlay. Use when the user wants to see their dashboard.",
      inputSchema: z.object({
        spoken_summary: z
          .string()
          .describe("Brief spoken response, e.g. 'Opening your dashboard'"),
      }),
      execute: async (args) => ({
        action: "open_dashboard",
        spoken_summary: args.spoken_summary,
      }),
    }),

    close_dashboard: tool({
      description:
        "Close/hide the Neri dashboard overlay. Use when the user wants to dismiss the dashboard.",
      inputSchema: z.object({
        spoken_summary: z
          .string()
          .describe("Brief spoken response, e.g. 'Closing the dashboard'"),
      }),
      execute: async (args) => ({
        action: "close_dashboard",
        spoken_summary: args.spoken_summary,
      }),
    }),

    create_canvas: tool({
      description:
        "Generate visual HTML content and display it in a canvas window on the dashboard. Use for charts, comparisons, timers, visual displays. Generate complete, self-contained HTML with inline CSS using a dark theme.",
      inputSchema: z.object({
        title: z.string().describe("Window title for the canvas"),
        html: z
          .string()
          .describe(
            "Complete self-contained HTML document with inline CSS. Use dark theme (background: #0a0a14, text: #d4d4d8).",
          ),
        spoken_summary: z
          .string()
          .describe("Brief spoken response describing what was created"),
      }),
      execute: async (args) => ({
        action: "create_canvas",
        spoken_summary: args.spoken_summary,
        title: args.title,
        html: args.html,
      }),
    }),

    manage_windows: tool({
      description:
        "Manage existing dashboard windows — focus, close, or list them.",
      inputSchema: z.object({
        operation: z
          .enum(["focus", "close", "list"])
          .describe("The window management operation"),
        window_type: z
          .string()
          .optional()
          .describe("The type of window to target (for focus/close)"),
        spoken_summary: z
          .string()
          .describe("Brief spoken response about the action taken"),
      }),
      execute: async (args) => ({
        action: "manage_windows",
        spoken_summary: args.spoken_summary,
        operation: args.operation,
        window_type: args.window_type,
      }),
    }),

    message_orchestrator: tool({
      description:
        "Forward a complex task to the orchestrator for background processing. Use for file operations, shell commands, browser control, memory, scheduling, code editing — anything that requires deep system access.",
      inputSchema: z.object({
        message: z
          .string()
          .describe("The task to send to the orchestrator in natural language"),
        spoken_summary: z
          .string()
          .describe(
            "Brief acknowledgment for the user, e.g. 'I\\'m on it' or 'Working on that now'",
          ),
      }),
      execute: async (args) => {
        // Fire-and-forget to orchestrator via scheduler
        try {
          await ctx.scheduler.runAfter(0, internal.agent.invoke.invoke, {
            prompt: args.message,
            agentType: "orchestrator",
          });
        } catch (err) {
          console.error("[mercury] Failed to schedule orchestrator:", err);
        }

        return {
          action: "message_orchestrator",
          spoken_summary: args.spoken_summary,
        };
      },
    }),

    no_response: tool({
      description:
        "Use when the request is casual conversation, greetings, or chitchat that doesn't need any tool action. The voice agent handles these naturally.",
      inputSchema: z.object({}),
      execute: async () => ({
        action: "no_response",
      }),
    }),
  };
}
