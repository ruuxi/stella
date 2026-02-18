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
import type { createToolHost } from "../tools";
export type ChatRequest = {
    conversationId: string;
    userMessageId: string;
    agent?: "orchestrator" | "general" | "self_mod";
    attachments?: Array<{
        id?: string;
        url?: string;
        mimeType?: string;
    }>;
};
export type RuntimeConfig = {
    deviceId: string;
    ownerId: string;
    toolHost: ReturnType<typeof createToolHost>;
    proxyUrl?: string;
    authToken?: string;
};
/**
 * Handle a chat request locally.
 * Returns a ReadableStream for SSE streaming to the client.
 */
export declare function handleChat(request: ChatRequest, config: RuntimeConfig): Promise<Response>;
/**
 * Run a subagent task. Called via setImmediate from TaskCreate.
 */
export declare function runSubagentTask(taskId: string, config: RuntimeConfig): Promise<void>;
/**
 * Set up task completion delivery.
 * When a top-level task completes, re-invoke the orchestrator.
 */
export declare function initRuntime(config: RuntimeConfig): void;
