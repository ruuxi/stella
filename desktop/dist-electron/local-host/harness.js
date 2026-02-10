/**
 * Harness execution engine for Claude Code and Codex AI SDK providers.
 *
 * These providers run locally (they spawn CLI child processes) and cannot
 * run in the Convex serverless backend.  When a user selects a harness
 * model (e.g. "claude-code/opus" or "codex/gpt-5.1-codex-max") the
 * Electron main process uses this module to stream the agent response.
 *
 * Stella's backend tools (OpenCanvas, RecallMemories, SaveMemory, TaskCreate,
 * etc.) are exposed as in-process MCP servers so the harness agents can use
 * them alongside their own native tools.
 */
import { streamText } from "ai";
import { createClaudeCode, createCustomMcpServer, } from "ai-sdk-provider-claude-code";
import { createCodexAppServer, createSdkMcpServer as createCodexSdkMcpServer, tool as codexTool, } from "ai-sdk-provider-codex-app-server";
import { z } from "zod";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Parse "claude-code/opus" → { provider: "claude-code", modelId: "opus" } */
export function parseHarnessModel(model) {
    if (model.startsWith("claude-code/")) {
        return { provider: "claude-code", modelId: model.slice("claude-code/".length) };
    }
    if (model.startsWith("codex/")) {
        return { provider: "codex", modelId: model.slice("codex/".length) };
    }
    return null;
}
/** Check whether a model string refers to a harness provider. */
export function isHarnessModel(model) {
    return model.startsWith("claude-code/") || model.startsWith("codex/");
}
// ---------------------------------------------------------------------------
// Stella MCP tools — exposed to harness agents via in-process MCP servers
// ---------------------------------------------------------------------------
function createClaudeCodeStellaMcp(ctx) {
    return createCustomMcpServer({
        name: "stella",
        tools: {
            OpenCanvas: {
                description: "Display content in the canvas side panel. If url is provided, renders in iframe; otherwise loads a Vite-compiled TSX panel from workspace/panels/{name}.tsx.",
                inputSchema: z.object({
                    name: z.string().describe("Panel or app name"),
                    title: z.string().optional().describe("Panel header title"),
                    url: z.string().optional().describe("Dev server URL for workspace apps"),
                }),
                handler: async (args) => {
                    await ctx.callMutation("events.appendEvent", {
                        conversationId: ctx.conversationId,
                        type: "canvas_command",
                        deviceId: ctx.deviceId,
                        payload: { action: "open", name: args.name, title: args.title, url: args.url },
                    });
                    return { content: [{ type: "text", text: `Canvas opened: ${args.name}` }] };
                },
            },
            CloseCanvas: {
                description: "Close the canvas side panel.",
                inputSchema: z.object({}),
                handler: async () => {
                    await ctx.callMutation("events.appendEvent", {
                        conversationId: ctx.conversationId,
                        type: "canvas_command",
                        deviceId: ctx.deviceId,
                        payload: { action: "close" },
                    });
                    return { content: [{ type: "text", text: "Canvas closed." }] };
                },
            },
            RecallMemories: {
                description: "Look up relevant memories from past conversations. Returns synthesized context from the memory system.",
                inputSchema: z.object({
                    categories: z
                        .array(z.object({
                        category: z.string().describe("Memory category"),
                        subcategory: z.string().describe("Memory subcategory"),
                    }))
                        .min(1)
                        .max(3)
                        .describe("Category/subcategory pairs to search"),
                    query: z.string().describe("Natural language query describing what you need"),
                }),
                handler: async (args) => {
                    try {
                        const result = await ctx.callAction("data/memory.recall", {
                            categories: args.categories,
                            query: args.query,
                        });
                        const text = typeof result === "string" ? result : JSON.stringify(result);
                        return { content: [{ type: "text", text }] };
                    }
                    catch (e) {
                        return {
                            content: [{ type: "text", text: `Memory recall failed: ${e.message}` }],
                            isError: true,
                        };
                    }
                },
            },
            SaveMemory: {
                description: "Save something worth remembering across conversations. Automatically deduplicates.",
                inputSchema: z.object({
                    category: z.string().describe("Memory category (e.g., preferences, projects)"),
                    subcategory: z.string().describe("Memory subcategory (e.g., coding, setup)"),
                    content: z.string().describe("The information to remember (1-3 sentences)"),
                }),
                handler: async (args) => {
                    try {
                        await ctx.callAction("data/memory.save", {
                            category: args.category,
                            subcategory: args.subcategory,
                            content: args.content,
                        });
                        return { content: [{ type: "text", text: `Memory saved: ${args.category}/${args.subcategory}` }] };
                    }
                    catch (e) {
                        return {
                            content: [{ type: "text", text: `Memory save failed: ${e.message}` }],
                            isError: true,
                        };
                    }
                },
            },
            TaskCreate: {
                description: "Delegate a task to a Stella subagent for background execution. Returns a task_id immediately.",
                inputSchema: z.object({
                    description: z.string().describe("Short summary for logging"),
                    prompt: z.string().describe("Full instructions for the subagent"),
                    subagent_type: z
                        .enum(["general", "self_mod", "explore", "browser"])
                        .describe("Which subagent to use"),
                    include_history: z.boolean().optional().describe("Pass conversation context"),
                    thread_name: z.string().optional().describe("Create/reuse a named thread"),
                }),
                handler: async (args) => {
                    try {
                        const result = await ctx.callAction("agent/tasks.runSubagent", {
                            conversationId: ctx.conversationId,
                            userMessageId: ctx.userMessageId ?? ctx.conversationId,
                            targetDeviceId: ctx.deviceId,
                            description: args.description,
                            prompt: args.prompt,
                            subagentType: args.subagent_type,
                            includeHistory: args.include_history,
                            threadName: args.thread_name,
                        });
                        const text = typeof result === "string" ? result : JSON.stringify(result);
                        return { content: [{ type: "text", text }] };
                    }
                    catch (e) {
                        return {
                            content: [{ type: "text", text: `TaskCreate failed: ${e.message}` }],
                            isError: true,
                        };
                    }
                },
            },
            TaskOutput: {
                description: "Get the result of a background subagent task.",
                inputSchema: z.object({
                    task_id: z.string().describe("Task ID returned by TaskCreate"),
                }),
                handler: async (args) => {
                    try {
                        const result = await ctx.callQuery("agent/tasks.getOutputByExternalId", {
                            taskId: args.task_id,
                        });
                        if (!result) {
                            return { content: [{ type: "text", text: "Task not found." }] };
                        }
                        const task = result;
                        const text = task.status === "completed"
                            ? `Task completed.\n\n${task.result ?? ""}`
                            : task.status === "error"
                                ? `Task failed: ${task.error ?? "unknown error"}`
                                : `Task status: ${task.status}`;
                        return { content: [{ type: "text", text }] };
                    }
                    catch (e) {
                        return {
                            content: [{ type: "text", text: `TaskOutput failed: ${e.message}` }],
                            isError: true,
                        };
                    }
                },
            },
            TaskCancel: {
                description: "Cancel a running subagent task.",
                inputSchema: z.object({
                    task_id: z.string().describe("Task ID to cancel"),
                    reason: z.string().optional().describe("Why the task is being canceled"),
                }),
                handler: async (args) => {
                    try {
                        await ctx.callMutation("agent/tasks.cancelTask", {
                            taskId: args.task_id,
                            reason: args.reason,
                        });
                        return { content: [{ type: "text", text: "Task canceled." }] };
                    }
                    catch (e) {
                        return {
                            content: [{ type: "text", text: `TaskCancel failed: ${e.message}` }],
                            isError: true,
                        };
                    }
                },
            },
        },
    });
}
function createCodexStellaMcp(ctx) {
    const tools = [
        codexTool({
            name: "OpenCanvas",
            description: "Display content in the canvas side panel. If url is provided, renders in iframe; otherwise loads a Vite-compiled TSX panel.",
            parameters: z.object({
                name: z.string().describe("Panel or app name"),
                title: z.string().optional().describe("Panel header title"),
                url: z.string().optional().describe("Dev server URL for workspace apps"),
            }),
            execute: async (args) => {
                await ctx.callMutation("events.appendEvent", {
                    conversationId: ctx.conversationId,
                    type: "canvas_command",
                    deviceId: ctx.deviceId,
                    payload: { action: "open", name: args.name, title: args.title, url: args.url },
                });
                return { success: true, message: `Canvas opened: ${args.name}` };
            },
        }),
        codexTool({
            name: "CloseCanvas",
            description: "Close the canvas side panel.",
            parameters: z.object({}),
            execute: async () => {
                await ctx.callMutation("events.appendEvent", {
                    conversationId: ctx.conversationId,
                    type: "canvas_command",
                    deviceId: ctx.deviceId,
                    payload: { action: "close" },
                });
                return { success: true, message: "Canvas closed." };
            },
        }),
        codexTool({
            name: "RecallMemories",
            description: "Look up relevant memories from past conversations.",
            parameters: z.object({
                categories: z
                    .array(z.object({
                    category: z.string(),
                    subcategory: z.string(),
                }))
                    .min(1)
                    .max(3),
                query: z.string().describe("Natural language query"),
            }),
            execute: async (args) => {
                const result = await ctx.callAction("data/memory.recall", {
                    categories: args.categories,
                    query: args.query,
                });
                return typeof result === "string" ? result : JSON.stringify(result);
            },
        }),
        codexTool({
            name: "SaveMemory",
            description: "Save something worth remembering across conversations.",
            parameters: z.object({
                category: z.string(),
                subcategory: z.string(),
                content: z.string().describe("The information to remember"),
            }),
            execute: async (args) => {
                await ctx.callAction("data/memory.save", {
                    category: args.category,
                    subcategory: args.subcategory,
                    content: args.content,
                });
                return { success: true, message: `Memory saved: ${args.category}/${args.subcategory}` };
            },
        }),
        codexTool({
            name: "TaskCreate",
            description: "Delegate a task to a Stella subagent for background execution.",
            parameters: z.object({
                description: z.string(),
                prompt: z.string(),
                subagent_type: z.enum(["general", "self_mod", "explore", "browser"]),
                include_history: z.boolean().optional(),
                thread_name: z.string().optional(),
            }),
            execute: async (args) => {
                const result = await ctx.callAction("agent/tasks.runSubagent", {
                    conversationId: ctx.conversationId,
                    userMessageId: ctx.userMessageId ?? ctx.conversationId,
                    targetDeviceId: ctx.deviceId,
                    description: args.description,
                    prompt: args.prompt,
                    subagentType: args.subagent_type,
                    includeHistory: args.include_history,
                    threadName: args.thread_name,
                });
                return typeof result === "string" ? result : JSON.stringify(result);
            },
        }),
        codexTool({
            name: "TaskOutput",
            description: "Get the result of a background subagent task.",
            parameters: z.object({
                task_id: z.string(),
            }),
            execute: async (args) => {
                const result = await ctx.callQuery("agent/tasks.getOutputByExternalId", {
                    taskId: args.task_id,
                });
                if (!result)
                    return "Task not found.";
                const task = result;
                return task.status === "completed"
                    ? `Task completed.\n\n${task.result ?? ""}`
                    : task.status === "error"
                        ? `Task failed: ${task.error}`
                        : `Task status: ${task.status}`;
            },
        }),
        codexTool({
            name: "TaskCancel",
            description: "Cancel a running subagent task.",
            parameters: z.object({
                task_id: z.string(),
                reason: z.string().optional(),
            }),
            execute: async (args) => {
                await ctx.callMutation("agent/tasks.cancelTask", {
                    taskId: args.task_id,
                    reason: args.reason,
                });
                return { success: true, message: "Task canceled." };
            },
        }),
    ];
    return createCodexSdkMcpServer({ name: "stella", tools });
}
// ---------------------------------------------------------------------------
// Provider factories
// ---------------------------------------------------------------------------
function createClaudeCodeModel(modelId, opts, stellaMcp) {
    const mcpServers = {};
    if (stellaMcp) {
        mcpServers.stella = stellaMcp;
    }
    const provider = createClaudeCode({
        defaultSettings: {
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            cwd: opts?.cwd,
            mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        },
    });
    return provider(modelId, {
        systemPrompt: opts?.systemPrompt,
    });
}
function createCodexModel(modelId, opts, stellaMcp) {
    const mcpServers = {};
    if (stellaMcp) {
        mcpServers.stella = stellaMcp;
    }
    const provider = createCodexAppServer({
        defaultSettings: {
            cwd: opts?.cwd,
            sandboxMode: "workspace-write",
            threadMode: "stateless",
            baseInstructions: opts?.systemPrompt,
            mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        },
    });
    return provider(modelId);
}
// ---------------------------------------------------------------------------
// Streaming harness
// ---------------------------------------------------------------------------
let activeAbort = null;
/**
 * Stream a response using a harness provider (Claude Code or Codex).
 * Runs the AI SDK provider locally in the Electron main process.
 *
 * When `convexContext` is provided, Stella's backend tools (OpenCanvas,
 * RecallMemories, SaveMemory, TaskCreate, etc.) are exposed as in-process
 * MCP tools that the harness agent can call.
 */
export async function streamHarness(request, callbacks, convexContext) {
    const parsed = parseHarnessModel(request.model);
    if (!parsed) {
        callbacks.onError?.(new Error(`Unknown harness model: ${request.model}`));
        return;
    }
    // Create Stella MCP tools if Convex context is available
    let claudeCodeMcp;
    let codexMcp;
    if (convexContext) {
        if (parsed.provider === "claude-code") {
            claudeCodeMcp = createClaudeCodeStellaMcp(convexContext);
        }
        else {
            codexMcp = createCodexStellaMcp(convexContext);
        }
    }
    // Create the appropriate model with MCP tools
    const modelOpts = {
        cwd: request.cwd,
        systemPrompt: request.systemPrompt,
    };
    const model = parsed.provider === "claude-code"
        ? createClaudeCodeModel(parsed.modelId, modelOpts, claudeCodeMcp)
        : createCodexModel(parsed.modelId, modelOpts, codexMcp);
    // Abort any previous harness stream
    abortHarness();
    const controller = new AbortController();
    activeAbort = controller;
    try {
        const result = streamText({
            model,
            messages: request.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            abortSignal: controller.signal,
        });
        let fullText = "";
        for await (const chunk of result.textStream) {
            if (controller.signal.aborted)
                break;
            fullText += chunk;
            callbacks.onTextDelta?.(chunk);
        }
        if (!controller.signal.aborted) {
            callbacks.onDone?.(fullText);
        }
    }
    catch (error) {
        if (controller.signal.aborted) {
            // Aborted, not an error
            return;
        }
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    finally {
        if (activeAbort === controller) {
            activeAbort = null;
        }
    }
}
/**
 * Abort the currently running harness stream.
 */
export function abortHarness() {
    if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
    }
}
