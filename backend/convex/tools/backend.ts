import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ToolOptions } from "./types";

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

const schedulerSchema = z.object({
  action: z.enum([
    "heartbeat.get",
    "heartbeat.upsert",
    "heartbeat.run",
    "cron.list",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
  ]),
  params: z.record(z.any()).optional(),
});

const normalizeParams = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const readString = (params: Record<string, unknown>, key: string) => {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const readBoolean = (params: Record<string, unknown>, key: string) => {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
};

const readNumber = (params: Record<string, unknown>, key: string) => {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const readObject = (params: Record<string, unknown>, key: string) => {
  const value = params[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
};

const requireValue = <T,>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`${label} is required.`);
  }
  return value;
};

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

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

export const createBackendTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
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

  const stripHtml = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const truncateText = (value: string, max = 30_000) =>
    value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

  return {
    WebSearch: tool({
      description:
        "Search the web for up-to-date information using semantic search.",
      inputSchema: z.object({
        query: z.string().min(2),
      }),
      execute: async (args) => {
        const apiKey = process.env.EXA_API_KEY;
        if (!apiKey) {
          return "WebSearch is not configured (missing EXA_API_KEY).";
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
              contents: {
                text: { maxCharacters: 1000 },
              },
            }),
          });
          if (!response.ok) {
            return `WebSearch failed (${response.status}): ${await response.text()}`;
          }
          const data = (await response.json()) as {
            results?: Array<{
              title?: string;
              url?: string;
              text?: string;
            }>;
          };
          const results = data.results ?? [];
          if (results.length === 0) {
            return `No web results found for "${args.query}".`;
          }
          const formatted = results
            .map((r, i) => {
              const parts = [`${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}`];
              if (r.text) parts.push(`   ${r.text.slice(0, 300)}`);
              return parts.join("\n");
            })
            .join("\n\n");
          return `Web search results for "${args.query}":\n\n${formatted}`;
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),
    WebFetch: tool({
      description: "Fetch content from a URL.",
      inputSchema: z.object({
        url: z.string(),
        prompt: z.string(),
      }),
      execute: async (args) => {
        const secureUrl = args.url.replace(/^http:/, "https:");
        try {
          const response = await fetch(secureUrl, {
            headers: { "User-Agent": "StellaBackend/1.0" },
          });
          if (!response.ok) {
            return `Failed to fetch (${response.status} ${response.statusText})`;
          }
          const text = await response.text();
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("text/html") ? stripHtml(text) : text;
          return `Content from ${secureUrl}\nPrompt: ${args.prompt}\n\n${truncateText(body, 15_000)}`;
        } catch (error) {
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    }),
    IntegrationRequest: tool({
      description:
        "Send a request to an external integration using a stella-managed public key or a user secret.",
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
    ActivateSkill: tool({
      description:
        "Load the full instructions for a skill by its ID. Call this before using a skill.",
      inputSchema: z.object({
        skill_id: z.string().min(1),
      }),
      execute: async (args) => {
        const skill = await ctx.runQuery(api.skills.getSkillById, {
          skillId: args.skill_id,
        });
        if (!skill) {
          return `Skill not found: ${args.skill_id}`;
        }
        if (!skill.enabled) {
          return `Skill is disabled: ${args.skill_id}`;
        }
        const parts = [`## Skill: ${skill.name} (${skill.id})`];
        if (skill.requiresSecrets && skill.requiresSecrets.length > 0) {
          parts.push(
            `Requires credentials: ${skill.requiresSecrets.join(", ")}. Use RequestCredential if missing.`,
          );
        }
        if (skill.execution) {
          parts.push(`Execution: ${skill.execution}-only.`);
        }
        if (skill.secretMounts) {
          parts.push(
            "Use SkillBash for local commands so secrets are mounted automatically.",
          );
        }
        parts.push(skill.markdown);
        return parts.join("\n\n");
      },
    }),
    Scheduler: tool({
      description:
        "Manage heartbeat + cron schedules. action: heartbeat.get|heartbeat.upsert|heartbeat.run|cron.list|cron.add|cron.update|cron.remove|cron.run.",
      inputSchema: schedulerSchema,
      execute: async (args) => {
        const params = normalizeParams(args.params);
        switch (args.action) {
          case "heartbeat.get": {
            const conversationId = readString(params, "conversationId");
            const result = await ctx.runQuery(api.heartbeat.getConfig, {
              ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
            });
            return formatResult(result);
          }
          case "heartbeat.upsert": {
            const conversationId = readString(params, "conversationId");
            const upsertArgs: Record<string, unknown> = {};
            if (conversationId) upsertArgs.conversationId = conversationId;
            const enabled = readBoolean(params, "enabled");
            if (enabled !== undefined) upsertArgs.enabled = enabled;
            const intervalMs = readNumber(params, "intervalMs");
            if (intervalMs !== undefined) upsertArgs.intervalMs = intervalMs;
            const prompt = readString(params, "prompt");
            if (prompt !== undefined) upsertArgs.prompt = prompt;
            const checklist = readString(params, "checklist");
            if (checklist !== undefined) upsertArgs.checklist = checklist;
            const ackMaxChars = readNumber(params, "ackMaxChars");
            if (ackMaxChars !== undefined) upsertArgs.ackMaxChars = ackMaxChars;
            const deliver = readBoolean(params, "deliver");
            if (deliver !== undefined) upsertArgs.deliver = deliver;
            const agentType = readString(params, "agentType");
            if (agentType !== undefined) upsertArgs.agentType = agentType;
            const activeHours = readObject(params, "activeHours");
            if (activeHours !== undefined) upsertArgs.activeHours = activeHours;
            const targetDeviceId = readString(params, "targetDeviceId");
            if (targetDeviceId !== undefined) upsertArgs.targetDeviceId = targetDeviceId;
            const result = await ctx.runMutation(api.heartbeat.upsertConfig, upsertArgs);
            return formatResult(result);
          }
          case "heartbeat.run": {
            const conversationId = readString(params, "conversationId");
            const result = await ctx.runMutation(api.heartbeat.runNow, {
              ...(conversationId ? { conversationId } : {}),
            });
            return formatResult(result);
          }
          case "cron.list": {
            const result = await ctx.runQuery(api.cron_jobs.list, {});
            return formatResult(result);
          }
          case "cron.add": {
            const name = requireValue(readString(params, "name"), "name");
            const schedule = requireValue(readObject(params, "schedule"), "schedule");
            const payload = requireValue(readObject(params, "payload"), "payload");
            const sessionTarget = requireValue(readString(params, "sessionTarget"), "sessionTarget");
            const conversationId = readString(params, "conversationId");
            const description = readString(params, "description");
            const enabled = readBoolean(params, "enabled");
            const deleteAfterRun = readBoolean(params, "deleteAfterRun");
            const result = await ctx.runMutation(api.cron_jobs.add, {
              name,
              schedule,
              payload,
              sessionTarget,
              ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
              ...(description ? { description } : {}),
              ...(enabled !== undefined ? { enabled } : {}),
              ...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
            });
            return formatResult(result);
          }
          case "cron.update": {
            const jobId = readString(params, "jobId") ?? readString(params, "id");
            const patch = readObject(params, "patch");
            const resolvedJobId = requireValue(jobId, "jobId");
            const resolvedPatch = requireValue(patch, "patch");
            const result = await ctx.runMutation(api.cron_jobs.update, {
              jobId: resolvedJobId as Id<"cron_jobs">,
              patch: resolvedPatch,
            });
            return formatResult(result);
          }
          case "cron.remove": {
            const jobId = readString(params, "jobId") ?? readString(params, "id");
            const resolvedJobId = requireValue(jobId, "jobId");
            await ctx.runMutation(api.cron_jobs.remove, {
              jobId: resolvedJobId as Id<"cron_jobs">,
            });
            return "Cron job removed.";
          }
          case "cron.run": {
            const jobId = readString(params, "jobId") ?? readString(params, "id");
            const resolvedJobId = requireValue(jobId, "jobId");
            const result = await ctx.runMutation(api.cron_jobs.run, {
              jobId: resolvedJobId as Id<"cron_jobs">,
            });
            return formatResult(result);
          }
        }
      },
    }),
  };
};
