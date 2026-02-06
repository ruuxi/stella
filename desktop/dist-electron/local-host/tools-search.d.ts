/**
 * Search tools: Glob, Grep handlers.
 */
import type { ToolResult } from "./tools-types.js";
export declare const handleGlob: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleGrep: (args: Record<string, unknown>) => Promise<ToolResult>;
