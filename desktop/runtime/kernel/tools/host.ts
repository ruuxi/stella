/**
 * Tool host factory and registry.
 *
 * This module creates the tool execution environment and composes all tool handlers.
 * Individual tool implementations are split into domain-specific files:
 *
 * - tools-types.ts    — Shared type definitions
 * - tools-utils.ts    — Shared utilities (logging, path expansion, truncation, etc.)
 * - tools-file.ts     — Read, Edit handlers
 * - tools-search.ts   — Grep handler
 * - tools-shell.ts    — Bash handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — TaskCreate/TaskPause, TaskUpdate, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */

import path from "path";

// Types
import type {
  ToolContext,
  ToolHandlerExtras,
  ToolResult,
  ToolHostOptions,
  ToolMetadata,
} from "./types.js";

// Utilities
import { log, logError, recoverStaleSecretFiles } from "./utils.js";

// Tool handlers
import { setFileToolsConfig } from "./file.js";
import {
  createShellState,
  type ShellState,
} from "./shell.js";
import {
  createStateContext,
  type StateContext,
} from "./state.js";
import { type UserToolsConfig } from "./user.js";
import {
  createDisplayToolHandlers,
  createFileToolHandlers,
  createScheduleToolHandlers,
  createSearchToolHandlers,
  createShellToolHandlers,
  createTaskToolHandlers,
  createUserToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { TOOL_DESCRIPTIONS, TOOL_JSON_SCHEMAS } from "./schemas.js";
import { EXECUTE_TYPESCRIPT_TOOL_NAME } from "./execute-typescript-contract.js";
import { createExecuteTypescriptToolHandlers } from "./execute-typescript.js";

import type { ToolDefinition } from "../extensions/types.js";

// Re-export types for external consumers
export type { ToolContext, ToolHandlerExtras, ToolResult };

export const createToolHost = ({
  stellaRoot,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
  stellaUiCliPath,
  requestCredential,
  taskApi,
  scheduleApi,
  extensionTools,
  displayHtml,
}: ToolHostOptions) => {
  const stateRoot = path.join(stellaRoot, "state");
  const toolCatalog = new Map<string, ToolMetadata>(
    Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => [
      name,
      {
        name,
        description,
        parameters: (TOOL_JSON_SCHEMAS[name] ?? {}) as Record<string, unknown>,
      },
    ]),
  );

  // Configure file tools.
  setFileToolsConfig({ stellaRoot });

  // User tools config
  const userConfig: UserToolsConfig = { requestCredential };

  // Initialize shell and state contexts
  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath,
    stellaOfficeBinPath,
    stellaUiCliPath,
  });
  const stateContext: StateContext = createStateContext(stateRoot, taskApi);

  void recoverStaleSecretFiles(stateRoot)
    .then((result) => {
      if (result.recovered > 0 || result.skipped > 0) {
        log("Recovered stale secret mounts", result);
      }
    })
    .catch((error) => {
      logError("Failed to recover stale secret mounts", error);
    });

  const baseHandlers = mergeToolHandlers(
    createFileToolHandlers(),
    createSearchToolHandlers(),
    createShellToolHandlers(shellState),
    createTaskToolHandlers(stateContext),
    createUserToolHandlers(userConfig),
    createDisplayToolHandlers({ displayHtml }),
    createScheduleToolHandlers({ taskApi, scheduleApi }),
  );

  let handlers = baseHandlers;
  const executeCapabilityTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    extras?: ToolHandlerExtras,
  ): Promise<ToolResult> => {
    if (toolName === EXECUTE_TYPESCRIPT_TOOL_NAME) {
      return {
        error: `${EXECUTE_TYPESCRIPT_TOOL_NAME} cannot call itself recursively as a tool.`,
      };
    }
    const handler = handlers[toolName];
    if (!handler) {
      return { error: `Unknown nested tool: ${toolName}` };
    }
    return await handler(toolArgs, context, extras);
  };

  const codeHandlers = createExecuteTypescriptToolHandlers({
    stellaRoot,
    executeCapabilityTool,
  });
  handlers = mergeToolHandlers(baseHandlers, codeHandlers);

  registerExtensionToolHandlers(handlers, extensionTools);
  for (const tool of extensionTools ?? []) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  const executeTool = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => {
    const extras: ToolHandlerExtras = {
      ...(signal ? { signal } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    };
    log(`Executing tool: ${toolName}`, {
      args:
        toolName === EXECUTE_TYPESCRIPT_TOOL_NAME
          ? {
              summary: toolArgs.summary,
              codePreview: typeof toolArgs.code === "string"
                ? toolArgs.code.slice(0, 200)
                : undefined,
              timeoutMs: toolArgs.timeoutMs,
            }
          : toolName.includes("hera-browser")
        ? { code: (toolArgs.code as string)?.slice(0, 200) + "...", timeout: toolArgs.timeout }
        : toolArgs,
      context,
    });

    const handler = handlers[toolName];
    if (!handler) {
      const availableTools = Object.keys(handlers);
      logError(`Unknown tool: ${toolName}. Available tools:`, availableTools);
      return { error: `Unknown tool: ${toolName}` } satisfies ToolResult;
    }

    const startTime = Date.now();
    try {
      const result = await handler(toolArgs, context, extras);
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

  const killAllShells = () => {
    for (const shell of shellState.shells.values()) {
      if (shell.running) {
        shell.kill();
      }
    }
  };

  const killShellsByPort = (port: number) => {
    const portStr = String(port);
    for (const shell of shellState.shells.values()) {
      if (shell.running && shell.command.includes(portStr)) {
        shell.kill();
      }
    }
  };

  return {
    executeTool,
    getToolCatalog: () => Array.from(toolCatalog.values()),
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    killAllShells,
    killShellsByPort,
    registerExtensionTools: (tools: ToolDefinition[]) => {
      registerExtensionToolHandlers(handlers, tools);
      for (const tool of tools) {
        toolCatalog.set(tool.name, {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      }
    },
  };
};
