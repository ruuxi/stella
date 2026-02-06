import type { ToolContext, ToolResult } from "./tools.js";
/**
 * Tool Host interface for testing
 */
export interface ToolHost {
    executeTool: (toolName: string, toolArgs: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}
/**
 * Mock Tool Host Factory
 * Creates a configurable mock tool host for testing
 */
export declare function createMockToolHost(responses?: Map<string, ToolResult | ((args: Record<string, unknown>, ctx: ToolContext) => ToolResult)>): ToolHost & {
    callHistory: Array<{
        name: string;
        args: Record<string, unknown>;
        ctx: ToolContext;
    }>;
};
