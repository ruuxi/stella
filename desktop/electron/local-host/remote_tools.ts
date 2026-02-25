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

async function callBackendTool(
  opts: RemoteToolsOpts,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> {
  const result = await callConvexAction(opts, "agent/local_runtime:executeTool", {
    toolName,
    toolArgs,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();

export function createRemoteTools(opts: RemoteToolsOpts): Record<string, Tool<any, any>> {
  const memoryRecallCache = new Map<string, string>();

  const passthroughTool = (
    toolName: string,
    description: string,
    inputSchema: z.ZodType<Record<string, unknown>>,
  ): Tool<any, any> =>
    tool({
      description,
      inputSchema,
      execute: async (args: Record<string, unknown>) => {
        try {
          return await callBackendTool(opts, toolName, args);
        } catch (error) {
          return `${toolName} failed: ${(error as Error).message}`;
        }
      },
    });

  return {
    RecallMemories: tool({
      description: "Search semantic memory for relevant past interactions and knowledge",
      inputSchema: z.object({
        query: z.string().describe("Search query for memory recall"),
        limit: z.number().optional().describe("Max results to return"),
      }),
      execute: async (args: { query: string; limit?: number }) => {
        const cacheKey = `${args.query}::${args.limit ?? "default"}`;
        const cached = memoryRecallCache.get(cacheKey);
        if (cached) {
          return cached;
        }
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:recallMemories", {
            query: args.query,
            source: "memory",
            conversationId: opts.conversationId,
          });
          if (!result || (Array.isArray(result) && result.length === 0)) {
            const text = "No relevant memories found.";
            memoryRecallCache.set(cacheKey, text);
            return text;
          }
          const text = JSON.stringify(result);
          memoryRecallCache.set(cacheKey, text);
          return text;
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

    IntegrationRequest: passthroughTool(
      "IntegrationRequest",
      "Call an external integration endpoint securely via server-side secret handling.",
      looseObject({
        provider: z.string().optional(),
        endpoint: z.string().optional(),
        mode: z.string().optional(),
        secretId: z.string().optional(),
        request: z.record(z.string(), z.unknown()).optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),

    HeartbeatGet: passthroughTool(
      "HeartbeatGet",
      "Get current heartbeat automation configuration.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    HeartbeatUpsert: passthroughTool(
      "HeartbeatUpsert",
      "Create or update heartbeat automation settings.",
      looseObject({
        schedule: z.string().optional(),
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    HeartbeatRun: passthroughTool(
      "HeartbeatRun",
      "Run heartbeat automation now.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),

    CronList: passthroughTool(
      "CronList",
      "List cron automations.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    CronAdd: passthroughTool(
      "CronAdd",
      "Create a cron automation.",
      looseObject({
        schedule: z.string().optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        enabled: z.boolean().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronUpdate: passthroughTool(
      "CronUpdate",
      "Update an existing cron automation.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
        schedule: z.string().optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        enabled: z.boolean().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronRemove: passthroughTool(
      "CronRemove",
      "Remove a cron automation.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronRun: passthroughTool(
      "CronRun",
      "Run a cron automation immediately.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),

    OpenCanvas: passthroughTool(
      "OpenCanvas",
      "Open a workspace canvas panel.",
      looseObject({
        name: z.string().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CloseCanvas: passthroughTool(
      "CloseCanvas",
      "Close the workspace canvas panel.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),

    StoreSearch: passthroughTool(
      "StoreSearch",
      "Search the Stella store for packages.",
      looseObject({
        query: z.string().optional(),
        limit: z.number().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    GenerateApiSkill: passthroughTool(
      "GenerateApiSkill",
      "Generate and save an API integration skill from discovered endpoint specs.",
      looseObject({
        service: z.string().optional(),
        endpoints: z.array(z.record(z.string(), z.unknown())).optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),

    SpawnRemoteMachine: passthroughTool(
      "SpawnRemoteMachine",
      "Provision or enable the remote machine for always-on execution.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    ListResources: passthroughTool(
      "ListResources",
      "List available resources (local/cloud/connectors).",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    NoResponse: passthroughTool(
      "NoResponse",
      "Suppress user-facing response for this turn.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
  };
}
