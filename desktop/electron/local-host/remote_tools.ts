/**
 * AI SDK tool() instances for Convex-backed operations.
 *
 * These tools call Convex actions/mutations for operations that require
 * server-side execution (memory recall, web search, embeddings, etc.).
 */

import { tool, type Tool } from "ai";
import { z } from "zod";

export type RemoteToolsOpts = {
  convexUrl: string;
  authToken: string;
  conversationId: string;
  agentType: string;
};

async function callConvexAction(
  opts: RemoteToolsOpts,
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = opts.convexUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify({ path, args }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Convex action ${path} failed (${response.status}): ${text}`);
  }

  return await response.json();
}

export function createRemoteTools(opts: RemoteToolsOpts): Record<string, Tool<any, any>> {
  return {
    RecallMemories: tool({
      description: "Search semantic memory for relevant past interactions and knowledge",
      inputSchema: z.object({
        query: z.string().describe("Search query for memory recall"),
        limit: z.number().optional().describe("Max results to return"),
      }),
      execute: async (args: { query: string; limit?: number }) => {
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:recallMemories", {
            query: args.query,
            source: "memory",
            conversationId: opts.conversationId,
          });
          if (!result || (Array.isArray(result) && result.length === 0)) {
            return "No relevant memories found.";
          }
          return JSON.stringify(result);
        } catch (error) {
          return `Memory recall failed: ${(error as Error).message}`;
        }
      },
    }),

    SaveMemory: tool({
      description: "Save an important fact or insight to long-term memory",
      inputSchema: z.object({
        content: z.string().describe("The memory content to save"),
      }),
      execute: async (args: { content: string }) => {
        try {
          await callConvexAction(opts, "agent/local_runtime:saveMemory", {
            content: args.content,
            conversationId: opts.conversationId,
          });
          return "Memory saved.";
        } catch (error) {
          return `Failed to save memory: ${(error as Error).message}`;
        }
      },
    }),

    WebFetch: tool({
      description: "Fetch content from a URL",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch"),
        prompt: z.string().optional().describe("What to extract from the page"),
      }),
      execute: async (args: { url: string; prompt?: string }) => {
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:webFetch", {
            url: args.url,
            prompt: args.prompt,
            conversationId: opts.conversationId,
          });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) {
          return `WebFetch failed: ${(error as Error).message}`;
        }
      },
    }),

    WebSearch: tool({
      description: "Search the web for information",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        maxResults: z.number().optional(),
      }),
      execute: async (args: { query: string; maxResults?: number }) => {
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:webSearch", {
            query: args.query,
            conversationId: opts.conversationId,
            agentType: opts.agentType,
          });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),

    ActivateSkill: tool({
      description: "Load a skill's full instructions by ID",
      inputSchema: z.object({
        skillId: z.string().describe("The skill ID to activate"),
      }),
      execute: async (args: { skillId: string }) => {
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:activateSkill", {
            skillId: args.skillId,
          });
          if (!result || typeof result !== "string") {
            return `Skill '${args.skillId}' not found or has no content.`;
          }
          return result;
        } catch (error) {
          return `Failed to activate skill: ${(error as Error).message}`;
        }
      },
    }),
  };
}
