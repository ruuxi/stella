/**
 * AI SDK tool() instances for Convex-backed operations.
 *
 * These tools call Convex actions/mutations for operations that require
 * server-side execution (memory recall, web search, embeddings, etc.).
 */

import { tool } from "ai";
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

async function callConvexQuery(
  opts: RemoteToolsOpts,
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = opts.convexUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify({ path, args }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Convex query ${path} failed (${response.status}): ${text}`);
  }

  return await response.json();
}

export function createRemoteTools(opts: RemoteToolsOpts): Record<string, ReturnType<typeof tool>> {
  return {
    RecallMemories: tool({
      description: "Search semantic memory for relevant past interactions and knowledge",
      parameters: z.object({
        query: z.string().describe("Search query for memory recall"),
        limit: z.number().optional().describe("Max results to return"),
      }),
      execute: async (args) => {
        try {
          const result = await callConvexAction(opts, "data/memory:recallMemories", {
            query: args.query,
            limit: args.limit ?? 5,
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
      parameters: z.object({
        content: z.string().describe("The memory content to save"),
      }),
      execute: async (args) => {
        try {
          await callConvexAction(opts, "data/memory:saveMemory", {
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
      parameters: z.object({
        url: z.string().describe("URL to fetch"),
        prompt: z.string().optional().describe("What to extract from the page"),
      }),
      execute: async (args) => {
        try {
          const result = await callConvexAction(opts, "tools/backend:webFetch", {
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
      parameters: z.object({
        query: z.string().describe("Search query"),
        maxResults: z.number().optional(),
      }),
      execute: async (args) => {
        try {
          const result = await callConvexAction(opts, "tools/backend:webSearch", {
            query: args.query,
            maxResults: args.maxResults ?? 5,
            conversationId: opts.conversationId,
          });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),

    ActivateSkill: tool({
      description: "Load a skill's full instructions by ID",
      parameters: z.object({
        skillId: z.string().describe("The skill ID to activate"),
      }),
      execute: async (args) => {
        try {
          const result = await callConvexQuery(opts, "data/skills:getSkillMarkdown", {
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
