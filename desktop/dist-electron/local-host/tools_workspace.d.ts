/**
 * Workspace CRUD and dev server process management.
 *
 * Workspaces live at $STELLA_WORKSPACES_ROOT/{name}/ (default: ~/workspaces,
 * with legacy ~/.stella fallback) and are scaffolded as Vite+React projects.
 * The dev server is spawned via `bunx vite`.
 */
import type { ToolResult } from './tools-types.js';
export declare const getWorkspaceRoots: () => string[];
export declare const handleCreateWorkspace: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleStartDevServer: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleStopDevServer: (args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleListWorkspaces: () => Promise<ToolResult>;
