/**
 * Local agent runtime — runs the full agent loop in the Electron main process.
 * Replaces the Convex /api/chat handler for local mode.
 *
 * Flow:
 * 1. Receive chat request from local HTTP server
 * 2. Build system prompt from local SQLite
 * 3. Load history from local SQLite
 * 4. Resolve model config (BYOK or proxy)
 * 5. Call AI SDK streamText() with in-process tool execution
 * 6. Stream response back via SSE
 * 7. Save assistant message to SQLite
 */
import { streamText } from "ai";
import { insert, update, findById, newId } from "../db";
import { broadcastSSE } from "../server";
import { buildSystemPrompt } from "./prompt_builder";
import { loadRecentEvents, eventsToHistoryMessages, ORCHESTRATOR_HISTORY_MAX_TOKENS } from "./history";
import { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
import { withModelFailover } from "./model_failover";
import { createLocalTools } from "./tools";
import { generateSuggestions } from "./suggestions";
import { updateTaskStatus, setTaskCompletionCallback, } from "./tasks_local";
const log = (...args) => console.log("[local-runtime]", ...args);
const logError = (...args) => console.error("[local-runtime]", ...args);
// ─── Platform Guidance ───────────────────────────────────────────────────────
function getPlatformGuidance() {
    const platform = process.platform;
    if (platform === "win32") {
        return `## Platform: Windows\nYou are running on Windows. Use Windows-compatible commands:\n- Shell: Git Bash (bash syntax works)\n- Open apps: \`start <app>\`\n- Open URLs: \`start <url>\`\n- File paths: Use forward slashes in bash\n- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\``;
    }
    if (platform === "darwin") {
        return `## Platform: macOS\nYou are running on macOS. Use macOS-compatible commands:\n- Shell: bash/zsh\n- Open apps: \`open -a <app>\`\n- Open URLs: \`open <url>\`\n- Common paths: \`$HOME\`, \`~/Library/Application Support\``;
    }
    return `## Platform: Linux\nYou are running on Linux. Use Linux-compatible commands:\n- Shell: bash\n- Open apps: \`xdg-open\`\n- Open URLs: \`xdg-open <url>\`\n- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\``;
}
// ─── Main Chat Handler ───────────────────────────────────────────────────────
/**
 * Handle a chat request locally.
 * Returns a ReadableStream for SSE streaming to the client.
 */
export async function handleChat(request, config) {
    const { conversationId, userMessageId } = request;
    const { deviceId, ownerId, toolHost } = config;
    // Validate conversation exists
    const conversation = findById("conversations", conversationId);
    if (!conversation) {
        return new Response("Conversation not found", { status: 404 });
    }
    // Get user message
    const userEvent = findById("events", userMessageId);
    if (!userEvent || userEvent.type !== "user_message") {
        return new Response("User message not found", { status: 404 });
    }
    const userPayload = typeof userEvent.payload === "string"
        ? JSON.parse(userEvent.payload)
        : userEvent.payload;
    const userText = (typeof userPayload.text === "string" ? userPayload.text : "").trim();
    // Determine agent type
    const agentType = request.agent === "self_mod" ? "self_mod"
        : request.agent === "general" ? "general"
            : "orchestrator";
    // Build system prompt from local data
    const promptBuild = buildSystemPrompt(agentType, { ownerId, conversationId });
    // Load history
    const historyEvents = loadRecentEvents(conversationId, ORCHESTRATOR_HISTORY_MAX_TOKENS, userEvent.timestamp, userMessageId);
    const historyMessages = eventsToHistoryMessages(historyEvents);
    // Build user message content
    const contentParts = [];
    if (userText.length > 0) {
        contentParts.push({ type: "text", text: userText });
    }
    if (contentParts.length === 0) {
        contentParts.push({ type: "text", text: " " });
    }
    // Inject dynamic context + platform guidance
    const contextParts = [];
    if (promptBuild.dynamicContext)
        contextParts.push(promptBuild.dynamicContext);
    const platformGuidance = getPlatformGuidance();
    if (platformGuidance)
        contextParts.push(platformGuidance);
    if (contextParts.length > 0) {
        contentParts.push({
            type: "text",
            text: `\n\n<system-context>\n${contextParts.join("\n\n")}\n</system-context>`,
        });
    }
    // Resolve model
    const resolvedConfig = resolveModelConfig(agentType, ownerId);
    const fallbackConfig = resolveFallbackConfig(agentType, ownerId);
    const chatStartTime = Date.now();
    // Assemble tools
    const tools = createLocalTools({
        agentType,
        toolsAllowlist: promptBuild.toolsAllowlist,
        maxTaskDepth: promptBuild.maxTaskDepth,
        ownerId,
        conversationId,
        deviceId,
        toolHost,
    });
    // Stream shared args
    const streamTextSharedArgs = {
        system: promptBuild.systemPrompt,
        tools,
        messages: [
            ...historyMessages,
            {
                role: "user",
                content: contentParts,
            },
        ],
        onFinish: async ({ text, usage, totalUsage }) => {
            try {
                if (text.trim().length > 0) {
                    // Save assistant message
                    const now = Date.now();
                    insert("events", {
                        conversation_id: conversationId,
                        timestamp: now,
                        type: "assistant_message",
                        payload: JSON.stringify({ text }),
                        request_id: newId(),
                    });
                    // Update conversation
                    const usageTotals = (totalUsage ?? usage);
                    const totalTokens = usageTotals?.totalTokens ?? 0;
                    const currentTokens = conversation.token_count ?? 0;
                    update("conversations", {
                        token_count: currentTokens + totalTokens,
                        updated_at: now,
                    }, { id: conversationId });
                    broadcastSSE(conversationId, "event_added", {
                        type: "assistant_message",
                        payload: { text },
                    });
                }
                // Log usage
                const usageTotals = (totalUsage ?? usage);
                if (usageTotals) {
                    insert("usage_logs", {
                        owner_id: ownerId,
                        conversation_id: conversationId,
                        agent_type: agentType,
                        model: typeof resolvedConfig.model === "string" ? resolvedConfig.model : "byok",
                        input_tokens: usageTotals.inputTokens ?? null,
                        output_tokens: usageTotals.outputTokens ?? null,
                        total_tokens: usageTotals.totalTokens ?? null,
                        duration_ms: Date.now() - chatStartTime,
                        success: 1,
                        created_at: Date.now(),
                    });
                }
                // Best-effort suggestions
                generateSuggestions(conversationId, ownerId).catch((err) => {
                    logError("Suggestion generation failed:", err);
                });
            }
            catch (err) {
                logError("onFinish error:", err);
            }
        },
    };
    // Execute with failover
    try {
        const result = withModelFailover(() => streamText({ ...resolvedConfig, ...streamTextSharedArgs }), fallbackConfig
            ? () => streamText({ ...fallbackConfig, ...streamTextSharedArgs })
            : undefined);
        // Stream the text chunks via SSE to conversation listeners
        const textStream = result.textStream;
        const streamToSSE = async () => {
            try {
                for await (const chunk of textStream) {
                    broadcastSSE(conversationId, "streaming_text", { text: chunk });
                }
                broadcastSSE(conversationId, "streaming_done", {});
            }
            catch (err) {
                logError("Stream error:", err);
                broadcastSSE(conversationId, "streaming_done", { error: String(err) });
            }
        };
        // Don't await — let it stream in background
        streamToSSE();
        // Return the AI SDK response for the direct HTTP caller
        return result.toUIMessageStreamResponse();
    }
    catch (error) {
        logError("Chat failed:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
}
// ─── Task Runner ─────────────────────────────────────────────────────────────
/**
 * Run a subagent task. Called via setImmediate from TaskCreate.
 */
export async function runSubagentTask(taskId, config) {
    const task = findById("tasks", taskId);
    if (!task || task.status !== "pending")
        return;
    updateTaskStatus(taskId, "running");
    log(`Running task ${taskId}: ${task.description}`);
    try {
        const promptBuild = buildSystemPrompt(task.agent_type, {
            ownerId: config.ownerId,
            conversationId: task.conversation_id,
        });
        const resolvedConfig = resolveModelConfig(task.agent_type, config.ownerId);
        const tools = createLocalTools({
            agentType: task.agent_type,
            toolsAllowlist: promptBuild.toolsAllowlist,
            maxTaskDepth: Math.max(0, promptBuild.maxTaskDepth - task.task_depth),
            ownerId: config.ownerId,
            conversationId: task.conversation_id,
            deviceId: config.deviceId,
            toolHost: config.toolHost,
        });
        const result = await streamText({
            ...resolvedConfig,
            system: promptBuild.systemPrompt,
            tools,
            messages: [{ role: "user", content: task.prompt }],
        });
        const text = await result.text;
        updateTaskStatus(taskId, "completed", { result: text });
        log(`Task ${taskId} completed`);
    }
    catch (error) {
        logError(`Task ${taskId} failed:`, error);
        updateTaskStatus(taskId, "failed", { error: error.message });
    }
}
// ─── Initialize Runtime ──────────────────────────────────────────────────────
/**
 * Set up task completion delivery.
 * When a top-level task completes, re-invoke the orchestrator.
 */
export function initRuntime(config) {
    setTaskCompletionCallback((task) => {
        log(`Delivering task result for ${task.id} to orchestrator`);
        // Re-invoke orchestrator with the task result as context
        // This is a simplified version — full implementation would
        // call handleChat with a synthetic message
    });
}
