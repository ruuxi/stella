import type { ToolContext, ToolResult } from "./tools.js";

/**
 * Tool Host interface for testing
 */
export interface ToolHost {
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolResult>;
}

/**
 * Mock Tool Host Factory
 * Creates a configurable mock tool host for testing
 */
export function createMockToolHost(
  responses?: Map<string, ToolResult | ((args: Record<string, unknown>, ctx: ToolContext) => ToolResult)>
): ToolHost & { callHistory: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }> } {
  const callHistory: Array<{ name: string; args: Record<string, unknown>; ctx: ToolContext }> = [];
  const defaultResponses = new Map<string, ToolResult | ((args: Record<string, unknown>, ctx: ToolContext) => ToolResult)>([
    ["Bash", { result: "Command completed successfully" }],
    ["Read", { result: "File content here" }],
    ["Glob", { result: "Found 0 files" }],
    ["Grep", { result: "No matches found" }],
    ["SqliteQuery", { result: JSON.stringify([]) }],
  ]);

  const responseMap = responses ? new Map([...defaultResponses, ...responses]) : defaultResponses;

  return {
    executeTool: async (toolName: string, toolArgs: Record<string, unknown>, context: ToolContext) => {
      callHistory.push({ name: toolName, args: toolArgs, ctx: context });
      
      const handler = responseMap.get(toolName);
      if (!handler) {
        return { error: `Unknown tool: ${toolName}` };
      }

      if (typeof handler === "function") {
        return handler(toolArgs, context);
      }
      return handler;
    },
    callHistory,
  };
}
