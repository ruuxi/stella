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
 * - tools-shell.ts    — Bash, SkillBash, KillShell handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — TodoWrite, TestWrite, Task, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */

import path from "path";
import { loadPluginsFromHome } from "./plugins.js";

// Types
import type {
  ToolContext,
  ToolResult,
  ToolHostOptions,
  PluginSyncPayload,
  SecretMountSpec,
} from "./tools-types.js";

// Utilities
import { log, logError } from "./tools-utils.js";

// Tool handlers
import { handleSqliteQuery } from "./tools-database.js";
import { handleRead, handleWrite, handleEdit } from "./tools-file.js";
import { handleGlob, handleGrep } from "./tools-search.js";
import {
  createShellState,
  handleBash,
  handleSkillBash,
  handleKillShell,
  type ShellState,
} from "./tools-shell.js";
import { handleWebFetch, handleWebSearch } from "./tools-web.js";
import {
  createStateContext,
  handleTodoWrite,
  handleTestWrite,
  handleTask,
  handleTaskOutput,
  type StateContext,
} from "./tools-state.js";
import { handleAskUser, handleRequestCredential, type UserToolsConfig } from "./tools-user.js";

// Re-export types for external consumers
export type { ToolContext, ToolResult, PluginSyncPayload };

export const createToolHost = ({ stellarHome, requestCredential, resolveSecret }: ToolHostOptions) => {
  const stateRoot = path.join(stellarHome, "state");
  const pluginsRoot = path.join(stellarHome, "plugins");

  // Plugin state
  const pluginHandlers = new Map<
    string,
    (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  >();
  let pluginSyncPayload: PluginSyncPayload = {
    plugins: [],
    tools: [],
    skills: [],
    agents: [],
  };

  // User tools config
  const userConfig: UserToolsConfig = { requestCredential };

  // Secret resolution helper for shell tools
  const resolveSecretValue = async (
    spec: SecretMountSpec,
    cache: Map<string, string>,
  ): Promise<string | null> => {
    if (cache.has(spec.provider)) {
      return cache.get(spec.provider) ?? null;
    }
    if (!resolveSecret) return null;

    let resolved = await resolveSecret({ provider: spec.provider });
    if (!resolved && requestCredential) {
      const response = await requestCredential({
        provider: spec.provider,
        label: spec.label ?? spec.provider,
        description: spec.description,
        placeholder: spec.placeholder,
      });
      resolved = await resolveSecret({
        provider: spec.provider,
        secretId: response.secretId,
      });
    }

    if (!resolved) return null;
    cache.set(spec.provider, resolved.plaintext);
    return resolved.plaintext;
  };

  // Initialize shell and state contexts
  const shellState: ShellState = createShellState(resolveSecretValue);
  const stateContext: StateContext = createStateContext(stateRoot);

  const setSkills = (skills: PluginSyncPayload["skills"]) => {
    shellState.skillCache = skills;
  };

  const loadPlugins = async (): Promise<PluginSyncPayload> => {
    log("Loading plugins from:", pluginsRoot);
    const loaded = await loadPluginsFromHome(pluginsRoot);
    pluginHandlers.clear();
    for (const [name, handler] of loaded.handlers.entries()) {
      log("Registering plugin handler:", name);
      pluginHandlers.set(name, handler);
    }
    log("Total plugin handlers registered:", pluginHandlers.size);

    pluginSyncPayload = {
      plugins: loaded.plugins,
      tools: loaded.tools.map((tool) => ({
        pluginId: tool.pluginId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        source: tool.source,
      })),
      skills: loaded.skills,
      agents: loaded.agents,
    };

    return pluginSyncPayload;
  };

  const notConfigured = (name: string): ToolResult => ({
    result: `${name} is not configured on this device yet.`,
  });

  // Handler registry
  const handlers: Record<
    string,
    (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  > = {
    // File tools
    Read: (args) => handleRead(args),
    Write: (args) => handleWrite(args),
    Edit: (args) => handleEdit(args),

    // Search tools
    Glob: (args) => handleGlob(args),
    Grep: (args) => handleGrep(args),

    // Shell tools
    Bash: (args, context) => handleBash(shellState, args, context),
    SkillBash: (args) => handleSkillBash(shellState, args),
    KillShell: (args) => handleKillShell(shellState, args),

    // Web tools
    WebFetch: (args) => handleWebFetch(args),
    WebSearch: (args) => handleWebSearch(args),

    // State tools
    TodoWrite: (args, context) => handleTodoWrite(stateContext, args, context),
    TestWrite: (args, context) => handleTestWrite(stateContext, args, context),
    Task: (args) => handleTask(stateContext, args),
    TaskOutput: (args) => handleTaskOutput(stateContext, args),

    // User tools
    AskUserQuestion: (args) => handleAskUser(args),
    RequestCredential: (args) => handleRequestCredential(userConfig, args),

    // Database tools
    SqliteQuery: (args, context) => handleSqliteQuery(args, context),

    // Placeholder tools (not yet implemented)
    ImageGenerate: async () => notConfigured("ImageGenerate"),
    ImageEdit: async () => notConfigured("ImageEdit"),
    VideoGenerate: async () => notConfigured("VideoGenerate"),
  };

  const executeTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
  ) => {
    log(`Executing tool: ${toolName}`, {
      args: toolName.includes("hera-browser")
        ? { code: (toolArgs.code as string)?.slice(0, 200) + "...", timeout: toolArgs.timeout }
        : toolArgs,
      context,
    });

    const handler = handlers[toolName] ?? pluginHandlers.get(toolName);
    if (!handler) {
      const availableTools = [
        ...Object.keys(handlers),
        ...Array.from(pluginHandlers.keys()),
      ];
      logError(`Unknown tool: ${toolName}. Available tools:`, availableTools);
      return { error: `Unknown tool: ${toolName}` } satisfies ToolResult;
    }

    const startTime = Date.now();
    try {
      const result = await handler(toolArgs, context);
      const duration = Date.now() - startTime;
      log(`Tool ${toolName} completed in ${duration}ms`, {
        hasResult: "result" in result,
        hasError: "error" in result,
        resultPreview: result.error
          ? result.error.slice(0, 500)
          : typeof result.result === "string"
            ? result.result.slice(0, 500)
            : "(non-string result)",
      });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logError(`Tool ${toolName} threw after ${duration}ms:`, error);
      return { error: `Tool ${toolName} failed: ${(error as Error).message}` };
    }
  };

  return {
    executeTool,
    getShells: () => Array.from(shellState.shells.values()),
    loadPlugins,
    getPluginSyncPayload: () => pluginSyncPayload,
    setSkills,
  };
};
