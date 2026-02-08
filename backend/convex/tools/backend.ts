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

type CronScheduleArg =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronPayloadArg =
  | { kind: "systemEvent"; text: string; agentType?: string; deliver?: boolean }
  | {
      kind: "agentTurn";
      message: string;
      agentType?: string;
      deliver?: boolean;
      includeHistory?: boolean;
    };

type CronPatchArg = {
  name?: string;
  schedule?: CronScheduleArg;
  payload?: CronPayloadArg;
  sessionTarget?: string;
  conversationId?: Id<"conversations">;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
};

const coerceCronSchedule = (value: unknown): CronScheduleArg | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (kind === "at") {
    const atMs = typeof record.atMs === "number" && Number.isFinite(record.atMs) ? record.atMs : undefined;
    return atMs !== undefined ? { kind: "at", atMs } : undefined;
  }
  if (kind === "every") {
    const everyMs =
      typeof record.everyMs === "number" && Number.isFinite(record.everyMs)
        ? record.everyMs
        : undefined;
    if (everyMs === undefined) return undefined;
    const anchorMs =
      typeof record.anchorMs === "number" && Number.isFinite(record.anchorMs)
        ? record.anchorMs
        : undefined;
    return anchorMs !== undefined ? { kind: "every", everyMs, anchorMs } : { kind: "every", everyMs };
  }
  if (kind === "cron") {
    const expr = typeof record.expr === "string" ? record.expr.trim() : "";
    if (!expr) return undefined;
    const tz = typeof record.tz === "string" && record.tz.trim() ? record.tz.trim() : undefined;
    return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
  }
  return undefined;
};

const coerceCronPayload = (value: unknown): CronPayloadArg | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const agentType =
    typeof record.agentType === "string" && record.agentType.trim()
      ? record.agentType.trim()
      : undefined;
  const deliver = typeof record.deliver === "boolean" ? record.deliver : undefined;

  if (kind === "systemEvent") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return undefined;
    return { kind: "systemEvent", text, ...(agentType ? { agentType } : {}), ...(deliver !== undefined ? { deliver } : {}) };
  }

  if (kind === "agentTurn") {
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) return undefined;
    const includeHistory =
      typeof record.includeHistory === "boolean" ? record.includeHistory : undefined;
    return {
      kind: "agentTurn",
      message,
      ...(agentType ? { agentType } : {}),
      ...(deliver !== undefined ? { deliver } : {}),
      ...(includeHistory !== undefined ? { includeHistory } : {}),
    };
  }

  return undefined;
};

const coerceCronPatch = (value: unknown): CronPatchArg | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const patch: CronPatchArg = {};

  if (typeof record.name === "string") patch.name = record.name;
  if (typeof record.description === "string") patch.description = record.description;
  if (typeof record.sessionTarget === "string") patch.sessionTarget = record.sessionTarget;
  if (typeof record.enabled === "boolean") patch.enabled = record.enabled;
  if (typeof record.deleteAfterRun === "boolean") patch.deleteAfterRun = record.deleteAfterRun;
  if (typeof record.conversationId === "string" && record.conversationId.trim()) {
    patch.conversationId = record.conversationId as Id<"conversations">;
  }

  const schedule = coerceCronSchedule(record.schedule);
  if (schedule) patch.schedule = schedule;
  const payload = coerceCronPayload(record.payload);
  if (payload) patch.payload = payload;

  return patch;
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
      const secret = await ctx.runQuery(internal.data.secrets.getSecretForTool, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.data.secrets.touchSecretUsage, {
        ownerId,
        secretId: secretId as Id<"secrets">,
      });
      await ctx.runMutation(internal.data.secrets.auditSecretAccess, {
        ownerId,
        secretId: secretId as Id<"secrets">,
        toolName,
        requestId,
        status: "allowed",
      });
      return await handler(secret.plaintext);
    } catch (error) {
      try {
        await ctx.runMutation(internal.data.secrets.auditSecretAccess, {
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
        const skill = await ctx.runQuery(api.data.skills.getSkillById, {
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
            const result = await ctx.runQuery(api.scheduling.heartbeat.getConfig, {
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
            const result = await ctx.runMutation(api.scheduling.heartbeat.upsertConfig, upsertArgs);
            return formatResult(result);
          }
          case "heartbeat.run": {
            const conversationId = readString(params, "conversationId");
            const result = await ctx.runMutation(api.scheduling.heartbeat.runNow, {
              ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
            });
            return formatResult(result);
          }
          case "cron.list": {
            const result = await ctx.runQuery(api.scheduling.cron_jobs.list, {});
            return formatResult(result);
          }
          case "cron.add": {
            const name = requireValue(readString(params, "name"), "name");
            const schedule = requireValue(coerceCronSchedule(params.schedule), "schedule");
            const payload = requireValue(coerceCronPayload(params.payload), "payload");
            const sessionTarget = requireValue(readString(params, "sessionTarget"), "sessionTarget");
            const conversationId = readString(params, "conversationId");
            const description = readString(params, "description");
            const enabled = readBoolean(params, "enabled");
            const deleteAfterRun = readBoolean(params, "deleteAfterRun");
            const result = await ctx.runMutation(api.scheduling.cron_jobs.add, {
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
            const patch = coerceCronPatch(params.patch);
            const resolvedJobId = requireValue(jobId, "jobId");
            const resolvedPatch = requireValue(patch, "patch");
            const result = await ctx.runMutation(api.scheduling.cron_jobs.update, {
              jobId: resolvedJobId as Id<"cron_jobs">,
              patch: resolvedPatch,
            });
            return formatResult(result);
          }
          case "cron.remove": {
            const jobId = readString(params, "jobId") ?? readString(params, "id");
            const resolvedJobId = requireValue(jobId, "jobId");
            await ctx.runMutation(api.scheduling.cron_jobs.remove, {
              jobId: resolvedJobId as Id<"cron_jobs">,
            });
            return "Cron job removed.";
          }
          case "cron.run": {
            const jobId = readString(params, "jobId") ?? readString(params, "id");
            const resolvedJobId = requireValue(jobId, "jobId");
            const result = await ctx.runMutation(api.scheduling.cron_jobs.run, {
              jobId: resolvedJobId as Id<"cron_jobs">,
            });
            return formatResult(result);
          }
        }
      },
    }),
    OpenCanvas: tool({
      description:
        "Display content in the canvas side panel. For panels (single-file TSX), write the file first then call this. For workspace apps, start the dev server first then pass the url.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Name of the panel or app. For panels, matches the file at frontend/workspace/panels/{name}.tsx. For apps, matches the directory at ~/.stella/apps/{name}/.",
          ),
        title: z.string().optional().describe("Panel header title. Defaults to name."),
        url: z
          .string()
          .optional()
          .describe(
            "Dev server URL for workspace apps (e.g. http://localhost:5180). If provided, renders in an iframe. If omitted, loads as a panel via Vite dynamic import.",
          ),
      }),
      execute: async (args) => {
        const conversationId = options.conversationId;
        if (!conversationId) {
          return "OpenCanvas requires a conversation context.";
        }
        await ctx.runMutation(internal.events.appendInternalEvent, {
          conversationId: conversationId as Id<"conversations">,
          type: "canvas_command",
          payload: {
            action: "open",
            name: args.name,
            title: args.title ?? args.name,
            ...(args.url ? { url: args.url } : {}),
          },
        });
        return `Canvas opened: ${args.name}`;
      },
    }),
    CloseCanvas: tool({
      description: "Close the canvas side panel.",
      inputSchema: z.object({}),
      execute: async () => {
        const conversationId = options.conversationId;
        if (!conversationId) {
          return "CloseCanvas requires a conversation context.";
        }
        await ctx.runMutation(internal.events.appendInternalEvent, {
          conversationId: conversationId as Id<"conversations">,
          type: "canvas_command",
          payload: { action: "close" },
        });
        return "Canvas closed.";
      },
    }),
    StoreSearch: tool({
      description:
        "Search the app store for packages matching a user need. Use when the user expresses a desire for functionality that might exist as a package.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        type: z
          .enum(["skill", "mod", "theme", "canvas", "plugin"])
          .optional()
          .describe("Filter by package type"),
      }),
      execute: async (args) => {
        const results = (await ctx.runQuery(api.data.store_packages.search, {
          query: args.query,
          type: args.type,
        })) as Array<{
          packageId: string;
          name: string;
          type: string;
          description: string;
          version: string;
          downloads: number;
        }>;

        if (results.length === 0) {
          return "No packages found in the store.";
        }

        const formatted = results
          .slice(0, 10)
          .map(
            (r, i) =>
              `${i + 1}. **${r.name}** (\`${r.packageId}\`) — ${r.type}\n   ${r.description}\n   v${r.version} | ${r.downloads} installs`,
          )
          .join("\n\n");

        return `Found ${results.length} package(s) in the store:\n\n${formatted}`;
      },
    }),
    SelfModInstallBlueprint: tool({
      description:
        "Install a shared blueprint from the store. Fetches the blueprint and provides reference code and implementation notes for re-implementation.",
      inputSchema: z.object({
        package_id: z.string().min(1).describe("The store package ID to install"),
      }),
      execute: async (args) => {
        const pkg = await ctx.runQuery(api.data.store_packages.getByPackageId, {
          packageId: args.package_id,
        });

        if (!pkg) {
          return `Blueprint not found: ${args.package_id}`;
        }

        if (!pkg.modPayload) {
          return `Package "${pkg.name}" has no blueprint payload.`;
        }

        const blueprint = pkg.modPayload as {
          format?: string;
          name?: string;
          description?: string;
          implementation?: string;
          referenceFiles?: Array<{
            path: string;
            action: string;
            content: string;
          }>;
        };

        const parts: string[] = [];
        parts.push(`# Blueprint: ${blueprint.name ?? pkg.name}`);
        parts.push("");
        parts.push("## What it does");
        parts.push(blueprint.description ?? pkg.description);
        parts.push("");

        if (blueprint.implementation) {
          parts.push("## How it was implemented");
          parts.push(blueprint.implementation);
          parts.push("");
        }

        if (blueprint.referenceFiles && blueprint.referenceFiles.length > 0) {
          parts.push(`## Reference files (${blueprint.referenceFiles.length})`);
          parts.push("");
          for (const file of blueprint.referenceFiles) {
            parts.push(`### ${file.action.toUpperCase()}: ${file.path}`);
            parts.push("```");
            parts.push(file.content);
            parts.push("```");
            parts.push("");
          }
        }

        parts.push("## Instructions");
        parts.push("Re-implement this feature for the current codebase. Read the reference files to understand what was done, then use Write/Edit to implement it your way.");
        parts.push("Use SelfModStart to create a feature, then SelfModApply when done.");
        parts.push("You are NOT copying files — understand the blueprint's intent and adapt to the current codebase.");

        return parts.join("\n");
      },
    }),
    GenerateApiSkill: tool({
      description:
        "Generate a reusable API skill from a discovered API map. Converts structured API discovery output into a persistent skill with endpoint documentation, auth configuration, and usage instructions.",
      inputSchema: z.object({
        service: z.string().describe("Service name (e.g. 'Spotify')"),
        baseUrl: z.string().describe("API base URL"),
        auth: z
          .object({
            type: z
              .string()
              .describe("Auth type: bearer, cookie, header, oauth"),
            tokenSource: z
              .string()
              .optional()
              .describe("Where the token comes from"),
            headerName: z
              .string()
              .optional()
              .describe("Header name for auth"),
            notes: z
              .string()
              .optional()
              .describe("Refresh, expiry, etc."),
          })
          .optional(),
        endpoints: z.array(
          z.object({
            path: z.string(),
            method: z.string().optional(),
            description: z.string().optional(),
            params: z.record(z.string()).optional(),
            responseShape: z.string().optional(),
            rateLimit: z.string().optional(),
          }),
        ),
        sessionNotes: z.string().optional(),
        skillId: z
          .string()
          .optional()
          .describe(
            "Custom skill ID (auto-generated from service name if omitted)",
          ),
        tags: z.array(z.string()).optional(),
        canvasHint: z
          .string()
          .optional()
          .describe(
            "Suggested canvas for results: table, chart, feed, player, dashboard",
          ),
      }),
      execute: async (args) => {
        const skillId =
          args.skillId ??
          args.service
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") +
            "-api";

        const lines: string[] = [];
        lines.push(`# ${args.service} API`);
        lines.push("");
        lines.push(`Discovered API integration for ${args.service}.`);
        lines.push("");
        lines.push("## Base URL");
        lines.push(`\`${args.baseUrl}\``);
        lines.push("");

        if (args.auth) {
          lines.push("## Authentication");
          lines.push(`- **Type**: ${args.auth.type}`);
          if (args.auth.headerName)
            lines.push(`- **Header**: ${args.auth.headerName}`);
          if (args.auth.tokenSource)
            lines.push(`- **Source**: ${args.auth.tokenSource}`);
          if (args.auth.notes)
            lines.push(`- **Notes**: ${args.auth.notes}`);
          lines.push("");
        }

        lines.push("## Endpoints");
        lines.push("");
        for (const ep of args.endpoints) {
          const method = (ep.method ?? "GET").toUpperCase();
          lines.push(`### ${method} ${ep.path}`);
          if (ep.description) lines.push(ep.description);
          if (ep.params && Object.keys(ep.params).length > 0) {
            lines.push("**Parameters:**");
            for (const [key, desc] of Object.entries(ep.params)) {
              lines.push(`- \`${key}\`: ${desc}`);
            }
          }
          if (ep.responseShape)
            lines.push(`**Response:** ${ep.responseShape}`);
          if (ep.rateLimit)
            lines.push(`**Rate limit:** ${ep.rateLimit}`);
          lines.push("");
        }

        lines.push("## Usage");
        lines.push("");
        lines.push("Call endpoints using `IntegrationRequest`:");
        lines.push("```");
        lines.push("IntegrationRequest({");
        lines.push(`  provider: "${skillId}",`);
        if (args.auth) {
          const authType =
            args.auth.type === "cookie" ? "header" : args.auth.type;
          lines.push(
            `  auth: { type: "${authType}"${args.auth.headerName ? `, header: "${args.auth.headerName}"` : ""} },`,
          );
        }
        lines.push("  request: {");
        lines.push(`    url: "${args.baseUrl}<endpoint_path>",`);
        lines.push('    method: "GET",');
        lines.push("  }");
        lines.push("})");
        lines.push("```");
        lines.push("");
        lines.push(
          "If no credentials are stored, use `RequestCredential` to obtain them, or delegate to the browser agent to extract tokens from an active session.",
        );

        if (args.sessionNotes) {
          lines.push("");
          lines.push("## Session Notes");
          lines.push(args.sessionNotes);
        }

        if (args.canvasHint) {
          lines.push("");
          lines.push("## Display");
          lines.push(
            `Suggested canvas for results: **${args.canvasHint}**`,
          );
          const canvasMap: Record<string, string> = {
            table: "data-table",
            chart: "chart",
            feed: "json-viewer",
            player: "proxy",
            dashboard: "proxy",
          };
          const component = canvasMap[args.canvasHint] ?? "data-table";
          lines.push(
            `Use \`Canvas(action="open", component="${component}", tier="data", data={...})\` to display results.`,
          );
        }

        const markdown = lines.join("\n");
        const requiresSecrets: string[] = [];
        if (args.auth && args.auth.type !== "cookie") {
          requiresSecrets.push(skillId);
        }

        await ctx.runMutation(api.data.skills.upsertMany, {
          skills: [
            {
              id: skillId,
              name: `${args.service} API`,
              description: `API integration for ${args.service} — ${args.endpoints.length} endpoints`,
              markdown,
              agentTypes: ["general"],
              tags: args.tags ?? ["api", "integration", "generated"],
              requiresSecrets:
                requiresSecrets.length > 0 ? requiresSecrets : undefined,
              source: "generated",
              enabled: true,
            },
          ],
        });

        return `Skill "${skillId}" created with ${args.endpoints.length} endpoints.\n\nAgents can now use ActivateSkill("${skillId}") to load the ${args.service} API documentation and call endpoints via IntegrationRequest.`;
      },
    }),
  };
};
