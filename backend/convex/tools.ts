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
  "IntegrationRequest",
  "SkillBash",
  "ImageGenerate",
  "ImageEdit",
  "VideoGenerate",
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

const integrationAuthSchema = z
  .object({
    type: z.enum(["bearer", "header", "query", "basic"]).optional(),
    header: z.string().optional(),
    query: z.string().optional(),
    format: z.string().optional(),
    username: z.string().optional(),
  })
  .optional();

const integrationRequestSchema = z.object({
  provider: z.string().min(1),
  mode: z.enum(["public", "private"]).optional(),
  secretId: z.string().optional(),
  publicKeyEnv: z.string().optional(),
  auth: integrationAuthSchema,
  request: z.object({
    url: z.string().min(1),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.any().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  responseType: z.enum(["json", "text"]).optional(),
});

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

  const applyAuth = (
    key: string,
    auth: z.infer<typeof integrationAuthSchema> | undefined,
    url: URL,
    headers: Headers,
  ) => {
    const authType = auth?.type ?? "bearer";
    const formatValue = (template?: string) => {
      if (!template) return key;
      return template.includes("{key}") ? template.replace("{key}", key) : `${template}${key}`;
    };

    if (authType === "query") {
      const queryName = auth?.query ?? "api_key";
      url.searchParams.set(queryName, formatValue(auth?.format));
      return;
    }

    if (authType === "basic") {
      const username = auth?.username ?? "";
      const token = btoa(`${username}:${key}`);
      headers.set("Authorization", `Basic ${token}`);
      return;
    }

    const headerName = auth?.header ?? "Authorization";
    const value =
      authType === "bearer" && !auth?.format ? `Bearer ${key}` : formatValue(auth?.format);
    headers.set(headerName, value);
  };

  const runIntegrationRequest = async (
    args: z.infer<typeof integrationRequestSchema>,
    key?: string,
  ) => {
    let url: URL;
    try {
      url = new URL(args.request.url);
    } catch {
      return "IntegrationRequest requires a valid URL.";
    }

    if (args.request.query) {
      for (const [name, value] of Object.entries(args.request.query)) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers = new Headers();
    if (args.request.headers) {
      for (const [name, value] of Object.entries(args.request.headers)) {
        headers.set(name, value);
      }
    }

    if (key) {
      applyAuth(key, args.auth, url, headers);
    }

    const method = (args.request.method ?? "GET").toUpperCase();
    let body: string | undefined;
    if (args.request.body !== undefined) {
      if (typeof args.request.body === "string") {
        body = args.request.body;
      } else {
        body = JSON.stringify(args.request.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    const timeoutMs = args.request.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const wantsText = args.responseType === "text";
      const wantsJson = args.responseType === "json" || contentType.includes("application/json");
      const data = wantsText
        ? await response.text()
        : wantsJson
          ? await response.json().catch(async () => await response.text())
          : await response.text();

      return JSON.stringify(
        {
          status: response.status,
          ok: response.ok,
          data,
        },
        null,
        2,
      );
    } catch (error) {
      return `IntegrationRequest failed: ${(error as Error).message}`;
    } finally {
      clearTimeout(timeout);
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
    IntegrationRequest: tool({
      description:
        "Send a request to an external integration using a Stellar-managed public key or a user secret.",
      inputSchema: integrationRequestSchema,
      execute: async (args) => {
        const mode =
          args.mode ?? (args.secretId ? "private" : args.publicKeyEnv ? "public" : "private");

        if (mode === "public") {
          const envName = args.publicKeyEnv?.trim();
          if (!envName) {
            return "IntegrationRequest requires publicKeyEnv when mode is public.";
          }
          const key = process.env[envName];
          if (!key) {
            return `Public integration is missing env var: ${envName}.`;
          }
          return await runIntegrationRequest(args, key);
        }

        if (!args.secretId) {
          return "IntegrationRequest requires secretId when mode is private.";
        }

        return await withSecret(String(args.secretId), "IntegrationRequest", async (secret) =>
          runIntegrationRequest(args, secret),
        );
      },
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
