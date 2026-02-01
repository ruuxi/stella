import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { streamText, generateText, tool } from "ai";
import { z } from "zod";
import { buildSystemPrompt } from "./prompt_builder";
import { createTools } from "./tools";
import { getModelConfig } from "./model";
import { authComponent, createAuth, requireConversationOwner } from "./auth";
import {
  buildDiscoveryBrowserPrompt,
  buildDiscoveryDevPrompt,
  buildDiscoveryAppsPrompt,
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
} from "./prompts";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "orchestrator" | "general" | "self_mod";
};

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd //c start <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\`
`.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\`
`.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\`
`.trim();
  }

  return "";
};

const HISTORY_LIMIT = 100;

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

const getCorsHeaders = (origin: string | null) => {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } as Record<string, string>;
};

const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

http.route({
  path: "/api/chat",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

http.route({
  path: "/api/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }
    let body: ChatRequest | null = null;
    try {
      body = (await request.json()) as ChatRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.conversationId || !body?.userMessageId) {
      return withCors(
        new Response("conversationId and userMessageId are required", {
          status: 400,
        }),
        origin,
      );
    }

    const conversationId = body.conversationId as Id<"conversations">;
    const userMessageId = body.userMessageId as Id<"events">;

    let conversation: Doc<"conversations"> | null = null;
    try {
      conversation = await requireConversationOwner(ctx, conversationId);
    } catch {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }
    if (!conversation) {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }

    const userEvent = await ctx.runQuery(internal.events.getById, {
      id: userMessageId,
    });
    if (!userEvent || userEvent.type !== "user_message") {
      return withCors(new Response("User message not found", { status: 404 }), origin);
    }

    if (userEvent.conversationId !== conversationId) {
      return withCors(new Response("Conversation mismatch", { status: 400 }), origin);
    }

    const targetDeviceId = userEvent.deviceId;
    if (!targetDeviceId) {
      return withCors(
        new Response("User message is missing deviceId", { status: 400 }),
        origin,
      );
    }

    const userPayload =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string; platform?: string })
        : {};
    const userText = userPayload.text ?? "";
    const userPlatform = userPayload.platform ?? "unknown";

    const historyLimit = Math.max(0, HISTORY_LIMIT - 1);
    const historyEvents =
      historyLimit > 0
        ? await ctx.runQuery(internal.events.listRecentMessages, {
            conversationId,
            limit: historyLimit,
            beforeTimestamp: userEvent.timestamp,
            excludeEventId: userMessageId,
          })
        : [];

    const historyMessages = historyEvents.flatMap((event: Doc<"events">) => {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { text?: string })
          : {};
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        return [];
      }
      return [
        {
          role: event.type === "assistant_message" ? ("assistant" as const) : ("user" as const),
          content: text,
        },
      ];
    });

    const attachments = body.attachments ?? [];
    const resolvedImages: Array<{ url: string; mimeType?: string }> = [];
    for (const attachment of attachments) {
      if (attachment.id) {
        const record = await ctx.runQuery(internal.attachments.getById, {
          id: attachment.id as Id<"attachments">,
        });
        if (record) {
          const storageUrl =
            record.url ??
            (await ctx.storage.getUrl(record.storageKey as Id<"_storage">));
          if (storageUrl) {
            resolvedImages.push({
              url: storageUrl,
              mimeType: record.mimeType ?? undefined,
            });
          }
        }
        continue;
      }
      if (attachment.url) {
        resolvedImages.push({
          url: attachment.url,
          mimeType: attachment.mimeType,
        });
      }
    }

    await ctx.runMutation(api.agents.ensureBuiltins, {});

    const agentType =
      body.agent === "self_mod"
        ? "self_mod"
        : body.agent === "general"
          ? "general"
          : "orchestrator";
    const promptBuild = await buildSystemPrompt(ctx, agentType, { ownerId: conversation.ownerId });

    // Add platform-specific guidance
    const platformGuidance = getPlatformGuidance(userPlatform);

    const pluginTools = await ctx.runQuery(api.plugins.listToolDescriptors, {});

    const contentParts: Array<
      { type: "text"; text: string } | { type: "image"; image: URL; mediaType?: string }
    > = [];
    const trimmedText = userText.trim();
    if (trimmedText.length > 0) {
      contentParts.push({ type: "text", text: trimmedText });
    }
    for (const image of resolvedImages) {
      try {
        contentParts.push({
          type: "image",
          image: new URL(image.url),
          mediaType: image.mimeType,
        });
      } catch {
        // Ignore invalid URLs.
      }
    }
    if (contentParts.length === 0) {
      contentParts.push({ type: "text", text: " " });
    }

    // Combine system prompt with platform guidance
    const systemPrompt = platformGuidance
      ? `${promptBuild.systemPrompt}\n\n${platformGuidance}`
      : promptBuild.systemPrompt;

    const result = await streamText({
      ...getModelConfig(agentType),
      system: systemPrompt,
      tools: createTools(
        ctx,
        {
          conversationId,
          userMessageId,
          targetDeviceId,
          agentType,
          sourceDeviceId: userEvent.deviceId,
        },
        {
          agentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools: pluginTools as Array<{
            pluginId: string;
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>,
          ownerId: conversation.ownerId,
        },
      ),
      messages: [
        ...historyMessages,
        {
          role: "user",
          content: contentParts,
        },
      ],
      onFinish: async ({ text, usage, totalUsage }) => {
        if (text.trim().length > 0) {
          await ctx.runMutation(internal.events.saveAssistantMessage, {
            conversationId,
            text,
            userMessageId,
          });
        }

        // Track cumulative token usage on conversation
        const usageTotals = totalUsage ?? usage;
        const totalTokens = usageTotals?.totalTokens ?? 0;
        if (totalTokens > 0) {
          await ctx.runMutation(internal.conversations.patchTokenCount, {
            conversationId,
            tokenDelta: totalTokens,
          });
        }

        // Check if current context size exceeds 50k input tokens.
        // Use the larger of last-step vs total usage for safety.
        const inputTokens = Math.max(usage?.inputTokens ?? 0, totalUsage?.inputTokens ?? 0);
        if (inputTokens > 50_000) {
          const oldestHistoryTimestamp =
            historyEvents.length > 0
              ? historyEvents[0]?.timestamp ?? Date.now()
              : Date.now();
          try {
            const olderEvents = await ctx.runQuery(
              internal.events.listOlderMessages,
              {
                conversationId,
                beforeTimestamp: oldestHistoryTimestamp,
                // Skip events already ingested in a previous run
                afterTimestamp: conversation.lastIngestedAt ?? undefined,
                limit: 50,
              },
            );
            if (olderEvents.length > 0) {
              const latestTimestamp = olderEvents[olderEvents.length - 1]?.timestamp ?? Date.now();
              // Schedule ingestion as a separate job so it runs independently
              await ctx.scheduler.runAfter(0, internal.memory.ingestSummary, {
                conversationId,
                ownerId: conversation.ownerId,
                ingestedThroughTimestamp: latestTimestamp,
                events: olderEvents.map((e: any) => ({
                  type: e.type as string,
                  text:
                    (e.payload &&
                      typeof e.payload === "object" &&
                      (e.payload as { text?: string }).text) ??
                    "",
                })),
              });
            }
          } catch {
            // Ingestion failure should not affect the chat response
          }
        }
      },
    });

    const response = result.toUIMessageStreamResponse();
    return withCors(response, origin);
  }),
});

// ---------------------------------------------------------------------------
// Discovery Endpoints (Stateless AI Proxy - No DB writes during discovery)
// ---------------------------------------------------------------------------

type DiscoveryAgentType = "browser" | "dev" | "apps";

type DiscoveryChatRequest = {
  agentType: DiscoveryAgentType;
  platform: "win32" | "darwin";
  trustLevel: "basic" | "full";
  messages: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    tool_name?: string;
  }>;
};

type DiscoverySynthesizeRequest = {
  rawOutputs: string;
  platform: "win32" | "darwin";
};

type DiscoveryCompleteRequest = {
  conversationId: string;
  coreMemory: string;
};

// Tool definitions for discovery agents (local execution on client)
// These tools don't have execute handlers - they just define the schema
// The client will execute them locally and send results back
const createDiscoveryTools = () => ({
  Bash: tool({
    description: "Execute a shell command. Returns stdout/stderr.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      description: z.string().optional().describe("Brief description of what the command does"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default 60000)"),
    }),
  }),
  Read: tool({
    description: "Read a file's contents with line numbers.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to the file"),
      offset: z.number().optional().describe("Starting line number (1-based)"),
      limit: z.number().optional().describe("Maximum lines to read"),
    }),
  }),
  Glob: tool({
    description: "Find files matching a glob pattern.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern to match"),
      path: z.string().optional().describe("Base directory for the search"),
    }),
  }),
  Grep: tool({
    description: "Search for text patterns in files.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("File or directory to search in"),
      glob: z.string().optional().describe("Only search files matching this glob"),
    }),
  }),
  SqliteQuery: tool({
    description: "Execute a read-only SQL query on a SQLite database.",
    inputSchema: z.object({
      database_path: z.string().describe("Absolute path to the SQLite database"),
      query: z.string().describe("SQL SELECT query to execute"),
      limit: z.number().optional().describe("Maximum rows to return (default 100)"),
    }),
  }),
});

const getDiscoveryPrompt = (agentType: DiscoveryAgentType, platform: "win32" | "darwin", trustLevel: "basic" | "full"): string => {
  switch (agentType) {
    case "browser":
      return buildDiscoveryBrowserPrompt({ platform, trustLevel });
    case "dev":
      return buildDiscoveryDevPrompt({ platform, trustLevel });
    case "apps":
      return buildDiscoveryAppsPrompt({ platform, trustLevel });
    default:
      throw new Error(`Unknown discovery agent type: ${agentType}`);
  }
};

// OPTIONS for discovery/chat
http.route({
  path: "/api/discovery/chat",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

// POST /api/discovery/chat - Stateless AI proxy for discovery agents
// Returns JSON with text response and tool_calls (if any)
// NO database writes - purely for AI inference
http.route({
  path: "/api/discovery/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: DiscoveryChatRequest | null = null;
    try {
      body = (await request.json()) as DiscoveryChatRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.agentType || !body?.platform || !body?.messages) {
      return withCors(
        new Response("agentType, platform, and messages are required", { status: 400 }),
        origin,
      );
    }

    const systemPrompt = getDiscoveryPrompt(body.agentType, body.platform, body.trustLevel ?? "basic");
    const modelConfig = getModelConfig(`discovery_${body.agentType}`);

    // Convert messages to AI SDK format
    type AiMessage =
      | { role: "user"; content: string }
      | { role: "assistant"; content: string; toolInvocations?: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }> }
      | { role: "tool"; content: Array<{ type: "tool-result"; toolCallId: string; toolName: string; result: unknown }> };

    const aiMessages: AiMessage[] = body.messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: msg.tool_call_id ?? "",
              toolName: msg.tool_name ?? "unknown",
              result: msg.content,
            },
          ],
        };
      }
      return {
        role: msg.role as "user" | "assistant",
        content: msg.content,
      };
    });

    try {
      const discoveryTools = createDiscoveryTools();
      const result = await generateText({
        ...modelConfig,
        system: systemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: aiMessages as any,
        tools: discoveryTools,
      });

      // Extract tool calls if any
      const toolCalls = (result.toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: (tc as any).args ?? {},
      }));

      const responseBody = JSON.stringify({
        text: result.text,
        toolCalls,
        finishReason: result.finishReason,
      });

      return withCors(
        new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("Discovery chat error:", error);
      return withCors(
        new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    }
  }),
});

// OPTIONS for discovery/synthesize
http.route({
  path: "/api/discovery/synthesize",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

// POST /api/discovery/synthesize - Synthesize raw outputs into core memory
// NO database writes - returns the synthesized profile
http.route({
  path: "/api/discovery/synthesize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: DiscoverySynthesizeRequest | null = null;
    try {
      body = (await request.json()) as DiscoverySynthesizeRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.rawOutputs) {
      return withCors(new Response("rawOutputs is required", { status: 400 }), origin);
    }

    const modelConfig = getModelConfig("discovery_synthesis");

    try {
      const result = await generateText({
        ...modelConfig,
        system: CORE_MEMORY_SYNTHESIS_PROMPT,
        messages: [
          {
            role: "user",
            content: buildCoreSynthesisUserMessage(body.rawOutputs),
          },
        ],
      });

      // Add metadata header
      const coreMemory = `# CORE_MEMORY
> Generated: ${new Date().toISOString()}
> Platform: ${body.platform === "win32" ? "Windows" : "macOS"}

${result.text}`;

      return withCors(
        new Response(JSON.stringify({ coreMemory }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("Discovery synthesize error:", error);
      return withCors(
        new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    }
  }),
});

// OPTIONS for discovery/complete
http.route({
  path: "/api/discovery/complete",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

// POST /api/discovery/complete - Generate and save welcome message
// This is the ONLY discovery endpoint that writes to the database
http.route({
  path: "/api/discovery/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("origin");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: DiscoveryCompleteRequest | null = null;
    try {
      body = (await request.json()) as DiscoveryCompleteRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.conversationId || !body?.coreMemory) {
      return withCors(
        new Response("conversationId and coreMemory are required", { status: 400 }),
        origin,
      );
    }

    const conversationId = body.conversationId as Id<"conversations">;

    let conversation: Doc<"conversations"> | null = null;
    try {
      conversation = await requireConversationOwner(ctx, conversationId);
    } catch {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }
    if (!conversation) {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }

    try {
      // Generate welcome message
      const modelConfig = getModelConfig("general");
      const result = await generateText({
        ...modelConfig,
        messages: [
          {
            role: "user",
            content: buildWelcomeMessagePrompt(body.coreMemory),
          },
        ],
      });

      const welcomeText = result.text.trim();

      // Save ONLY the welcome message to database
      if (welcomeText) {
        await ctx.runMutation(internal.events.saveAssistantMessage, {
          conversationId,
          text: welcomeText,
        });
      }

      return withCors(
        new Response(JSON.stringify({ welcomeMessage: welcomeText }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("Discovery complete error:", error);
      return withCors(
        new Response(JSON.stringify({ error: (error as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    }
  }),
});

export default http;
