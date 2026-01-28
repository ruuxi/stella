import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  createCoreDeviceTools,
  executeDeviceTool,
  sanitizeToolName,
  type DeviceToolContext,
} from "./device_tools";
import { jsonSchemaToZod } from "./plugins";

export const BASE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TestWrite",
  "AgentInvoke",
  "Task",
  "TaskOutput",
  "AskUserQuestion",
  "RequestCredential",
  "ImageGenerate",
  "ImageEdit",
  "VideoGenerate",
  "PublicGeminiImage",
  "PublicOpenAIImage",
  "PublicWhisper",
  "PublicPlacesSearch",
  "PrivateNotion",
  "PrivateTrello",
  "PrivateSpotify",
  "PrivateSonos",
  "PrivateHue",
] as const;

type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  pluginTools: PluginToolDescriptor[];
  ownerId?: string;
};

const filterTools = (
  tools: ToolSet,
  allowlist?: string[],
): ToolSet => {
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }
  const allowed = new Set(allowlist);
  const filteredEntries = Object.entries(tools).filter(([name]) => allowed.has(name));
  return Object.fromEntries(filteredEntries) as ToolSet;
};

const formatTaskResult = (task: {
  _id: Id<"tasks">;
  status: string;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}) => {
  const duration = (task.completedAt ?? Date.now()) - task.createdAt;
  if (task.status === "completed") {
    return `Task completed.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Result ---\n${
      task.result ?? "(no result)"
    }`;
  }
  if (task.status === "error") {
    return `Task failed.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Error ---\n${
      task.error ?? "(no error)"
    }`;
  }
  return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms`;
};

export const createTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
) => {
  const coreTools = createCoreDeviceTools(ctx, context);

  const requireOwnerId = (toolName: string) => {
    if (!options.ownerId) {
      return `${toolName} requires an authenticated owner context.`;
    }
    return null;
  };

  const withSecret = async (
    secretId: string,
    toolName: string,
    handler: (plaintext: string) => Promise<string>,
  ) => {
    if (!secretId || secretId === "undefined" || secretId === "null") {
      return `${toolName} requires a secretId.`;
    }
    const ownerCheck = requireOwnerId(toolName);
    if (ownerCheck) {
      return ownerCheck;
    }

    const ownerId = options.ownerId as string;
    const requestId = crypto.randomUUID();
    try {
      const secret = await ctx.runQuery(internal.secrets.getSecretForTool, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.secrets.touchSecretUsage, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.secrets.auditSecretAccess, {
        ownerId,
        secretId: secretId as Id<"secrets">,
        toolName,
        requestId,
        status: "allowed",
      });
      return await handler(secret.plaintext);
    } catch (error) {
      try {
        await ctx.runMutation(internal.secrets.auditSecretAccess, {
          ownerId,
          secretId: secretId as Id<"secrets">,
          toolName,
          requestId,
          status: "denied",
          reason: (error as Error).message,
        });
      } catch {
        // Ignore audit failures.
      }
      return `Secret access failed for ${toolName}.`;
    }
  };

  const pluginToolEntries = options.pluginTools.map((descriptor) => {
    // Sanitize tool name for AI provider compatibility (no dots allowed)
    const sanitizedName = sanitizeToolName(descriptor.name);
    return [
      sanitizedName,
      tool({
        description: descriptor.description,
        inputSchema: jsonSchemaToZod(descriptor.inputSchema),
        // Use original name for device dispatch
        execute: (args) => executeDeviceTool(ctx, context, descriptor.name, args),
      }),
    ] as const;
  });
  const pluginTools = Object.fromEntries(pluginToolEntries);

  const backendTools: ToolSet = {
    PublicGeminiImage: tool({
      description:
        "Generate an image with Stellar-managed Gemini integration (no user API key required).",
      inputSchema: z.object({
        prompt: z.string().min(1),
        resolution: z.string().optional(),
      }),
      execute: async () => {
        if (!process.env.GEMINI_API_KEY) {
          return "Public Gemini integration is not configured.";
        }
        return "Public Gemini integration is not wired yet.";
      },
    }),
    PublicOpenAIImage: tool({
      description:
        "Generate an image with Stellar-managed OpenAI integration (no user API key required).",
      inputSchema: z.object({
        prompt: z.string().min(1),
        size: z.string().optional(),
      }),
      execute: async () => {
        if (!process.env.OPENAI_API_KEY) {
          return "Public OpenAI image integration is not configured.";
        }
        return "Public OpenAI image integration is not wired yet.";
      },
    }),
    PublicWhisper: tool({
      description:
        "Transcribe audio with Stellar-managed Whisper integration (no user API key required).",
      inputSchema: z.object({
        audioUrl: z.string().min(1),
      }),
      execute: async () => {
        if (!process.env.OPENAI_API_KEY) {
          return "Public Whisper integration is not configured.";
        }
        return "Public Whisper integration is not wired yet.";
      },
    }),
    PublicPlacesSearch: tool({
      description:
        "Search places with Stellar-managed Places integration (no user API key required).",
      inputSchema: z.object({
        query: z.string().min(1),
        location: z.string().optional(),
      }),
      execute: async () => {
        if (!process.env.GOOGLE_PLACES_API_KEY) {
          return "Public Places integration is not configured.";
        }
        return "Public Places integration is not wired yet.";
      },
    }),
    PrivateNotion: tool({
      description: "Run a Notion request with a user-provided API key.",
      inputSchema: z.object({
        secretId: z.string().min(1),
        request: z.any().optional(),
      }),
      execute: async (args) =>
        withSecret(String(args.secretId), "PrivateNotion", async () => {
          return "Notion integration is not wired yet.";
        }),
    }),
    PrivateTrello: tool({
      description: "Run a Trello request with a user-provided API key.",
      inputSchema: z.object({
        secretId: z.string().min(1),
        request: z.any().optional(),
      }),
      execute: async (args) =>
        withSecret(String(args.secretId), "PrivateTrello", async () => {
          return "Trello integration is not wired yet.";
        }),
    }),
    PrivateSpotify: tool({
      description: "Run a Spotify request with a user-provided API key.",
      inputSchema: z.object({
        secretId: z.string().min(1),
        request: z.any().optional(),
      }),
      execute: async (args) =>
        withSecret(String(args.secretId), "PrivateSpotify", async () => {
          return "Spotify integration is not wired yet.";
        }),
    }),
    PrivateSonos: tool({
      description: "Run a Sonos request with a user-provided API key.",
      inputSchema: z.object({
        secretId: z.string().min(1),
        request: z.any().optional(),
      }),
      execute: async (args) =>
        withSecret(String(args.secretId), "PrivateSonos", async () => {
          return "Sonos integration is not wired yet.";
        }),
    }),
    PrivateHue: tool({
      description: "Run a Hue request with a user-provided API key.",
      inputSchema: z.object({
        secretId: z.string().min(1),
        request: z.any().optional(),
      }),
      execute: async (args) =>
        withSecret(String(args.secretId), "PrivateHue", async () => {
          return "Hue integration is not wired yet.";
        }),
    }),
  };

  const Task = tool({
    description: "Delegate a task to a specialized subagent.",
    inputSchema: z.object({
      description: z.string().min(1),
      prompt: z.string().min(1),
      subagent_type: z.string().min(1),
      run_in_background: z.boolean().optional(),
      resume: z.string().optional(),
    }),
    execute: async (args) => {
      const result = await ctx.runAction(api.tasks.runSubagent, {
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        subagentType: args.subagent_type,
        parentTaskId: options.currentTaskId,
      });

      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  const TaskOutput = tool({
    description: "Retrieve output from a background task.",
    inputSchema: z.object({
      task_id: z.string().min(1),
      block: z.boolean().optional(),
      timeout: z.number().optional(),
    }),
    execute: async (args) => {
      try {
        const record = await ctx.runQuery(api.tasks.getOutputByExternalId, {
          taskId: args.task_id,
        });
        if (!record) {
          return `Task not found: ${args.task_id}`;
        }
        return formatTaskResult(record as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
    },
  });

  const AgentInvoke = tool({
    description:
      "Invoke a bounded subagent-like tool call and return structured results.",
    inputSchema: z.object({
      agent_type: z.string().min(1),
      mode: z.string().optional(),
      prompt: z.string().optional(),
      input: z.any().optional(),
      result_schema: z.any().optional(),
      max_steps: z.number().int().positive().max(8).optional(),
      target_device_id: z.string().optional(),
    }),
    execute: async (args) => {
      if (args.target_device_id && args.target_device_id !== context.targetDeviceId) {
        return "agent.invoke must target the current device.";
      }

      const result = await ctx.runAction(api.agent.invoke, {
        agentType: args.agent_type,
        mode: args.mode,
        prompt: args.prompt,
        input: args.input,
        resultSchema: args.result_schema,
        maxSteps: args.max_steps,
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
      });

      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  const allTools: ToolSet = {
    ...coreTools,
    ...backendTools,
    ...pluginTools,
    Task,
    TaskOutput,
    AgentInvoke,
  };

  const allowlist = options.toolsAllowlist
    ? Array.from(
        new Set([
          // Sanitize allowlist entries and always include Task/TaskOutput/AgentInvoke
          ...options.toolsAllowlist.map(sanitizeToolName),
          "Task",
          "TaskOutput",
          "AgentInvoke",
          ...options.pluginTools.map((toolDef) => sanitizeToolName(toolDef.name)),
        ]),
      )
    : undefined;
  return filterTools(allTools, allowlist);
};

export type { DeviceToolContext };
