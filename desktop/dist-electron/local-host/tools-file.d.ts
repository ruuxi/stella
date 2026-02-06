/**
 * File tools: Read, Write, Edit handlers.
 */
import type { ToolResult } from "./tools-types.js";
export declare const handleRead: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleWrite: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleEdit: (args: Record<string, unknown>) => Promise<ToolResult>;
