/**
 * Web tools: WebFetch, WebSearch handlers.
 */
import type { ToolResult } from "./tools-types.js";
export declare const handleWebFetch: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleWebSearch: (args: Record<string, unknown>) => Promise<ToolResult>;
