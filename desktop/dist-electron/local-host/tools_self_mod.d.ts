/**
 * Self-modification device tool handlers.
 *
 * SelfModStart  — create/switch feature
 * SelfModApply  — apply staged changes atomically
 * SelfModRevert — undo a batch
 * SelfModStatus — show staging/history info
 * SelfModPackage — export as blueprint
 */
import type { ToolContext, ToolResult } from "./tools-types.js";
export declare const handleSelfModStart: (args: Record<string, unknown>, context: ToolContext, frontendRoot?: string) => Promise<ToolResult>;
export declare const handleSelfModApply: (args: Record<string, unknown>, context: ToolContext, frontendRoot?: string) => Promise<ToolResult>;
export declare const handleSelfModRevert: (args: Record<string, unknown>, context: ToolContext, frontendRoot?: string) => Promise<ToolResult>;
export declare const handleSelfModStatus: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
export declare const handleSelfModPackage: (args: Record<string, unknown>, context: ToolContext, frontendRoot?: string) => Promise<ToolResult>;
