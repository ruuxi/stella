/**
 * Tool host factory and registry.
 *
 * This module creates the tool execution environment and composes all tool handlers.
 * Individual tool implementations are split into domain-specific files:
 *
 * - tools-types.ts    — Shared type definitions
 * - tools-utils.ts    — Shared utilities (logging, path expansion, truncation, etc.)
 * - tools-database.ts — SqliteQuery handler
 * - tools-file.ts     — Read, Write, Edit handlers
 * - tools-search.ts   — Glob, Grep handlers
 * - tools-shell.ts    — Bash, SkillBash handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — Task, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */
import type { ToolContext, ToolResult, ToolHostOptions, PluginSyncPayload } from "./tools-types.js";
export type { ToolContext, ToolResult, PluginSyncPayload };
export declare const createToolHost: ({ StellaHome, requestCredential, resolveSecret }: ToolHostOptions) => {
    executeTool: (toolName: string, toolArgs: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
    getShells: () => import("./tools-types.js").ShellRecord[];
    loadPlugins: () => Promise<PluginSyncPayload>;
    getPluginSyncPayload: () => PluginSyncPayload;
    setSkills: (skills: PluginSyncPayload["skills"]) => void;
};
