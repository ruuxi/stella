/**
 * File tools: Read, Write, Edit handlers.
 * When the agent is self_mod and the file is within frontend/src/,
 * operations are redirected to the staging system.
 */
import type { ToolContext, ToolResult } from "./tools-types.js";
/** Options bag passed from tools.ts */
export type FileToolsConfig = {
    frontendRoot?: string;
};
export declare function setFileToolsConfig(config: FileToolsConfig): void;
export declare const handleRead: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
export declare const handleWrite: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
export declare const handleEdit: (args: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
