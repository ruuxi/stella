import { tool, ToolSet } from "ai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ToolOptions } from "./types";

const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), atMs: z.number() }),
  z.object({ kind: z.literal("every"), everyMs: z.number(), anchorMs: z.number().optional() }),
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string().optional() }),
]);

const cronPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("systemEvent"),
    text: z.string(),
    agentType: z.string().optional(),
    deliver: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("agentTurn"),
    message: z.string(),
    agentType: z.string().optional(),
    deliver: z.boolean().optional(),
  }),
]);

const cronPatchSchema = z.object({
  name: z.string().optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadSchema.optional(),
  sessionTarget: z.string().optional(),
  conversationId: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  deleteAfterRun: z.boolean().optional(),
});

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

/**
 * Wrap external content with safety markers so the LLM knows it's untrusted.
 */
const wrapExternalContent = (content: string, source: string): string =>
  `[External Content - Untrusted Source: ${source}]\n${content}\n[End External Content]`;

export const createBackendTools = (
  ctx: ActionCtx,
  _options: ToolOptions,
): ToolSet => {
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
        "Search the web for current information.\n\n" +
        "Usage:\n" +
        "- Returns up to 6 results with title, URL, and text snippet.\n" +
        "- Use for questions requiring up-to-date information beyond training data.\n" +
        "- query should be a natural language search phrase.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Search query (natural language)"),
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
          return wrapExternalContent(
            `Web search results for "${args.query}":\n\n${formatted}`,
            `web search: ${args.query}`,
          );
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),
    WebFetch: tool({
      description:
        "Fetch and read content from a URL.\n\n" +
        "Usage:\n" +
        "- Fetches the page content, strips HTML tags, and returns plain text.\n" +
        "- HTTP URLs are auto-upgraded to HTTPS.\n" +
        "- prompt describes what information you want to extract — it's returned alongside the content for context.\n" +
        "- Content is truncated to 15,000 characters.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch (HTTP auto-upgrades to HTTPS)"),
        prompt: z.string().describe("What information you want from this page"),
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
          return wrapExternalContent(
            `Content from ${secureUrl}\nPrompt: ${args.prompt}\n\n${truncateText(body, 15_000)}`,
            secureUrl,
          );
        } catch (error) {
          return `Error fetching URL: ${(error as Error).message}`;
        }
      },
    }),
    HeartbeatGet: tool({
      description:
        "Get the current heartbeat configuration for a conversation.\n\n" +
        "Returns the full config (interval, checklist, active hours, enabled status, last run info) or null if no heartbeat is configured.",
      inputSchema: z.object({
        conversationId: z.string().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runQuery(internal.scheduling.heartbeat.getConfig, {
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    HeartbeatUpsert: tool({
      description:
        "Create or update the heartbeat configuration for periodic monitoring.\n\n" +
        "Usage:\n" +
        "- One heartbeat per conversation. Creates a new config or updates the existing one.\n" +
        "- intervalMs: how often to poll (minimum 60000ms = 1 min, default 30 min).\n" +
        "- checklist: markdown checklist you'll read on each poll. Write as instructions to yourself.\n" +
        "- activeHours: quiet hours window (start/end in HH:MM, with optional timezone). Heartbeats outside this window are silently skipped.\n" +
        "- deliver: set to false to run silently without posting to conversation (default true).\n" +
        "- Only specified fields are changed on update — omitted fields are preserved.",
      inputSchema: z.object({
        conversationId: z.string().optional(),
        enabled: z.boolean().optional(),
        intervalMs: z.number().optional(),
        prompt: z.string().optional(),
        checklist: z.string().optional(),
        ackMaxChars: z.number().optional(),
        deliver: z.boolean().optional(),
        agentType: z.string().optional(),
        activeHours: z.object({
          start: z.string(),
          end: z.string(),
          timezone: z.string().optional(),
        }).optional(),
        targetDeviceId: z.string().optional(),
      }),
      execute: async (args) => {
        const { conversationId, ...rest } = args;
        const result = await ctx.runMutation(internal.scheduling.heartbeat.upsertConfig, {
          ...rest,
          ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    HeartbeatRun: tool({
      description:
        "Trigger an immediate heartbeat run without waiting for the next interval.\n\n" +
        "Useful for testing a heartbeat config or when the user says \"check now\".",
      inputSchema: z.object({
        conversationId: z.string().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.heartbeat.runNow, {
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
        });
        return formatResult(result);
      },
    }),
    CronList: tool({
      description:
        "List all cron jobs for the current user.\n\n" +
        "Returns up to 200 jobs (newest first) with their schedule, payload, status, and next run time.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await ctx.runQuery(internal.scheduling.cron_jobs.list, {});
        return formatResult(result);
      },
    }),
    CronAdd: tool({
      description:
        "Create a new scheduled cron job.\n\n" +
        "Usage:\n" +
        "- Schedule types: { kind: \"at\", atMs } for one-shot, { kind: \"every\", everyMs } for interval, { kind: \"cron\", expr, tz? } for cron expressions.\n" +
        "- Payload types: { kind: \"systemEvent\", text } for lightweight events, { kind: \"agentTurn\", message } for full agent execution.\n" +
        "- CONSTRAINT: sessionTarget=\"main\" requires systemEvent payload. sessionTarget=\"isolated\" requires agentTurn payload.\n" +
        "- deleteAfterRun=true auto-deletes \"at\" jobs after successful execution.\n" +
        "- Write text/message so it reads naturally at fire time (e.g. \"Reminder: You wanted to call the dentist today.\").",
      inputSchema: z.object({
        name: z.string(),
        schedule: cronScheduleSchema,
        payload: cronPayloadSchema,
        sessionTarget: z.string(),
        conversationId: z.string().optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        deleteAfterRun: z.boolean().optional(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.add, {
          name: args.name,
          schedule: args.schedule,
          payload: args.payload,
          sessionTarget: args.sessionTarget,
          ...(args.conversationId ? { conversationId: args.conversationId as Id<"conversations"> } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
          ...(args.deleteAfterRun !== undefined ? { deleteAfterRun: args.deleteAfterRun } : {}),
        });
        return formatResult(result);
      },
    }),
    CronUpdate: tool({
      description:
        "Update an existing cron job.\n\n" +
        "Usage:\n" +
        "- Only include fields you want to change in the patch — omitted fields are preserved.\n" +
        "- Recomputes the next run time on any update.",
      inputSchema: z.object({
        jobId: z.string(),
        patch: cronPatchSchema,
      }),
      execute: async (args) => {
        const { conversationId, ...restPatch } = args.patch;
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.update, {
          jobId: args.jobId as Id<"cron_jobs">,
          patch: {
            ...restPatch,
            ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
          },
        });
        return formatResult(result);
      },
    }),
    CronRemove: tool({
      description: "Permanently delete a cron job.",
      inputSchema: z.object({
        jobId: z.string(),
      }),
      execute: async (args) => {
        await ctx.runMutation(internal.scheduling.cron_jobs.remove, {
          jobId: args.jobId as Id<"cron_jobs">,
        });
        return "Cron job removed.";
      },
    }),
    CronRun: tool({
      description:
        "Trigger an immediate run of a cron job, ignoring its schedule.\n\n" +
        "The job executes now regardless of enabled status or next run time.",
      inputSchema: z.object({
        jobId: z.string(),
      }),
      execute: async (args) => {
        const result = await ctx.runMutation(internal.scheduling.cron_jobs.run, {
          jobId: args.jobId as Id<"cron_jobs">,
        });
        return formatResult(result);
      },
    }),
    NoResponse: tool({
      description:
        "Signal that you have nothing to say to the user right now. " +
        "Call this instead of generating a message when a system event, task result, or heartbeat check " +
        "does not warrant a visible response. Do NOT call this for user messages — always reply to users.",
      inputSchema: z.object({}),
      execute: async () => {
        return "__NO_RESPONSE__";
      },
    }),
  };
};
