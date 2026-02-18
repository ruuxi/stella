/**
 * Local tool assembly — creates AI SDK tool definitions that execute in-process.
 * Tools run synchronously via the existing tool host, eliminating the poll-based round-trip.
 */
import { type Tool } from "ai";
type ToolHost = {
    executeTool: (toolName: string, args: Record<string, unknown>, context: {
        conversationId: string;
        deviceId: string;
        requestId: string;
        agentType?: string;
    }) => Promise<{
        result?: unknown;
        error?: string;
    }>;
};
type ToolAssemblyOptions = {
    agentType: string;
    toolsAllowlist?: string[];
    maxTaskDepth: number;
    ownerId: string;
    conversationId: string;
    deviceId: string;
    toolHost: ToolHost;
};
/**
 * Build AI SDK tool definitions for the local agent runtime.
 * Device tools execute in-process via the tool host.
 * Orchestration tools (TaskCreate, etc.) use local SQLite.
 */
export declare function createLocalTools(options: ToolAssemblyOptions): Record<string, Tool<any, any>>;
export {};
