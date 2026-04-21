/**
 * Tool host factory.
 *
 * Builds the tool execution environment for a Stella session.
 *
 * Model-facing surface:
 *   - Orchestrator direct tools  -> coordination tools like TaskCreate, Display, WebSearch, Memory
 *   - Exec / Wait                -> code-mode runtime used by General and Schedule
 *   - AskUserQuestion / RequestCredential -> chat UI round-trips
 *
 * Internal subagents (Explore) reach `Read` / `Grep` directly through
 * `executeTool`; those handlers are registered without exposing them in the
 * tool catalog the LLM sees.
 */

import path from "node:path";
import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";

import type {
  ToolContext,
  ToolHandler,
  ToolHandlerExtras,
  ToolMetadata,
  ToolHostOptions,
  ToolResult,
} from "./types.js";

import { log, logError, recoverStaleSecretFiles } from "./utils.js";
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
  createInternalExploreHandlers,
  createMemoryToolHandlers,
  createScheduleToolHandlers,
  createTaskToolHandlers,
  createUserToolHandlers,
  createWebToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { TOOL_DESCRIPTIONS, TOOL_JSON_SCHEMAS } from "./schemas.js";
import {
  createExecToolRegistry,
  type ExecToolRegistry,
} from "./registry/registry.js";
import {
  createAllBuiltins,
  registerDescribeBuiltin,
  type CreateBuiltinsOptions,
} from "./registry/builtins/index.js";
import { createExecHost, type ExecHost } from "../exec/exec-host.js";
import { createExecToolHandlers } from "../exec/exec-tool.js";
import {
  EXEC_TOOL_NAME,
  WAIT_TOOL_NAME,
  buildExecToolDescription,
} from "../exec/exec-contract.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

const ORCHESTRATOR_DIRECT_TOOL_NAMES = new Set([
  "Display",
  "DisplayGuidelines",
  "WebSearch",
  "WebFetch",
  "Schedule",
  "TaskCreate",
  "TaskOutput",
  "TaskPause",
  "TaskUpdate",
  "Memory",
]);

export const createToolHost = ({
  stellaRoot,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaUiCliPath: _stellaUiCliPath,
  stellaComputerCliPath: _stellaComputerCliPath,
  requestCredential,
  taskApi,
  scheduleApi,
  extensionTools,
  displayHtml,
  webSearch,
  memoryStore,
  threadSummariesStore,
  stellaHome,
}: ToolHostOptions) => {
  const stateRoot = path.join(stellaRoot, "state");
  const toolCatalog = new Map<string, ToolMetadata>(
    Object.entries(TOOL_DESCRIPTIONS)
      .filter(([name]) => name !== "Read" && name !== "Grep")
      .map(([name, description]) => [
        name,
        {
          name,
          description,
          parameters: (TOOL_JSON_SCHEMAS[name] ?? {}) as Record<string, unknown>,
        },
      ]),
  );

  setFileToolsConfig({ stellaRoot });

  const userConfig: UserToolsConfig = { requestCredential };
  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaUiCliPath: _stellaUiCliPath,
    stellaComputerCliPath: _stellaComputerCliPath,
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

  // Build the Exec registry + host for the global `tools.*` surface.
  const registry: ExecToolRegistry = createExecToolRegistry();

  const builtinsOptions: CreateBuiltinsOptions = {
    shellState,
    stateContext,
    ...(scheduleApi ? { scheduleApi } : {}),
    ...(taskApi ? { taskApi } : {}),
    ...(displayHtml ? { displayHtml } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    ...(threadSummariesStore ? { threadSummariesStore } : {}),
    ...(stellaHome ? { stellaHome } : {}),
  };
  registry.registerMany(createAllBuiltins(builtinsOptions));
  registerDescribeBuiltin(registry);

  const execHost: ExecHost = createExecHost({ registry });
  // Update the Exec catalog description to reflect the live tool list.
  toolCatalog.set(EXEC_TOOL_NAME, {
    name: EXEC_TOOL_NAME,
    description: buildExecToolDescription(registry.list()),
    parameters: TOOL_JSON_SCHEMAS[EXEC_TOOL_NAME] as Record<string, unknown>,
  });

  let handlers: Record<string, ToolHandler> = mergeToolHandlers(
    createInternalExploreHandlers(),
    createDisplayToolHandlers({ displayHtml }),
    createWebToolHandlers({ webSearch }),
    createTaskToolHandlers(stateContext),
    createScheduleToolHandlers({ taskApi, scheduleApi }),
    ...(memoryStore ? [createMemoryToolHandlers({ memoryStore })] : []),
    createUserToolHandlers(userConfig),
    createExecToolHandlers(execHost),
  );

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
        toolName === EXEC_TOOL_NAME
          ? {
              summary: toolArgs.summary,
              sourcePreview:
                typeof toolArgs.source === "string"
                  ? toolArgs.source.slice(0, 200)
                  : typeof toolArgs.code === "string"
                    ? toolArgs.code.slice(0, 200)
                    : undefined,
              timeoutMs: toolArgs.timeoutMs,
            }
          : toolName === WAIT_TOOL_NAME
            ? {
                cell_id: toolArgs.cell_id,
                yield_after_ms: toolArgs.yield_after_ms,
              }
            : toolArgs,
      context,
    });

    const handler = handlers[toolName];
    if (!handler) {
      const available = Object.keys(handlers);
      logError(`Unknown tool: ${toolName}. Available tools:`, available);
      return { error: `Unknown tool: ${toolName}` } satisfies ToolResult;
    }

    const startedAt = Date.now();
    try {
      const result = await handler(toolArgs, context, extras);
      const duration = Date.now() - startedAt;
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
      const duration = Date.now() - startedAt;
      logError(`Tool ${toolName} threw after ${duration}ms:`, error);
      return { error: `Tool ${toolName} failed: ${(error as Error).message}` };
    }
  };

  const killAllShells = () => {
    for (const shell of shellState.shells.values()) {
      if (shell.running) shell.kill();
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

  const shutdown = async () => {
    killAllShells();
    if (execHost) {
      await execHost.shutdown();
    }
  };

  const getToolCatalog = (agentType?: string) =>
    Array.from(toolCatalog.values())
      .filter(
        (tool) =>
          agentType === AGENT_IDS.ORCHESTRATOR ||
          !ORCHESTRATOR_DIRECT_TOOL_NAMES.has(tool.name),
      )
      .map((tool) =>
        tool.name === EXEC_TOOL_NAME
          ? {
              ...tool,
              description: buildExecToolDescription(
                registry.list(
                  agentType ? { agentType } : undefined,
                ),
              ),
            }
          : tool,
      );

  return {
    executeTool,
    getToolCatalog,
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    killAllShells,
    killShellsByPort,
    shutdown,
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
    /**
     * Register an additional tool with the Exec registry. The new tool becomes
     * available the next time an `Exec` cell starts (or immediately if the
     * cell has not yet been launched).
     */
    registerExecTool: (tool: Parameters<ExecToolRegistry["register"]>[0]) => {
      registry.register(tool);
      toolCatalog.set(EXEC_TOOL_NAME, {
        name: EXEC_TOOL_NAME,
        description: buildExecToolDescription(registry.list()),
        parameters: TOOL_JSON_SCHEMAS[EXEC_TOOL_NAME] as Record<string, unknown>,
      });
    },
    getExecRegistry: () => registry,
    getExecHost: () => execHost,
  };
};
