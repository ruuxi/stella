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
export type HarnessProvider = "claude-code" | "codex";
export type HarnessConvexContext = {
    callMutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    callQuery: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    callAction: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    conversationId: string;
    deviceId: string;
    ownerId?: string;
    userMessageId?: string;
};
export type HarnessStreamRequest = {
    /** Full model string, e.g. "claude-code/opus" or "codex/gpt-5.1-codex-max" */
    model: string;
    /** System prompt to pass to the agent */
    systemPrompt?: string;
    /** Conversation messages (history + current user message) */
    messages: Array<{
        role: "user" | "assistant";
        content: string;
    }>;
    /** Working directory for the agent (defaults to user home) */
    cwd?: string;
};
export type HarnessStreamCallbacks = {
    onTextDelta?: (delta: string) => void;
    onDone?: (fullText: string) => void;
    onError?: (error: Error) => void;
};
/** Parse "claude-code/opus" → { provider: "claude-code", modelId: "opus" } */
export declare function parseHarnessModel(model: string): {
    provider: HarnessProvider;
    modelId: string;
} | null;
/** Check whether a model string refers to a harness provider. */
export declare function isHarnessModel(model: string): boolean;
/**
 * Stream a response using a harness provider (Claude Code or Codex).
 * Runs the AI SDK provider locally in the Electron main process.
 *
 * When `convexContext` is provided, Stella's backend tools (OpenCanvas,
 * RecallMemories, SaveMemory, TaskCreate, etc.) are exposed as in-process
 * MCP tools that the harness agent can call.
 */
export declare function streamHarness(request: HarnessStreamRequest, callbacks: HarnessStreamCallbacks, convexContext?: HarnessConvexContext): Promise<void>;
/**
 * Abort the currently running harness stream.
 */
export declare function abortHarness(): void;
