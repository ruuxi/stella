/**
 * Tool host factory.
 *
 * Builds the tool execution environment for a Stella session.
 *
 * Model-facing surface:
 *   - General codex-style tools  -> exec_command / write_stdin / apply_patch / etc.
 *   - macOS computer tools       -> computer_* (typed, mirror upstream computer-use MCP)
 *   - Coordination tools         -> TaskCreate, Display, Schedule, Memory
 *   - UI round-trips             -> AskUserQuestion / RequestCredential
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
  createAskQuestionToolHandlers,
  createComputerHandlers,
  createDisplayToolHandlers,
  createFilesystemToolHandlers,
  createImageToolHandlers,
  createMemoryToolHandlers,
  createParallelToolHandlers,
  createPatchToolHandlers,
  createScheduleControlToolHandlers,
  createScheduleToolHandlers,
  createShellToolHandlers,
  createTaskToolHandlers,
  createUserToolHandlers,
  createWebToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { TOOL_DESCRIPTIONS, TOOL_JSON_SCHEMAS } from "./schemas.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

const ORCHESTRATOR_DIRECT_TOOL_NAMES = new Set([
  "Display",
  "DisplayGuidelines",
  "Schedule",
  "TaskCreate",
  "TaskOutput",
  "TaskPause",
  "TaskUpdate",
  "Memory",
  "askQuestion",
]);

export const createToolHost = ({
  stellaRoot,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaUiCliPath: _stellaUiCliPath,
  stellaComputerCliPath,
  requestCredential,
  taskApi,
  scheduleApi,
  extensionTools,
  displayHtml,
  webSearch,
  getStellaSiteAuth,
  queryConvex,
  memoryStore,
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

  setFileToolsConfig({ stellaRoot });

  const userConfig: UserToolsConfig = { requestCredential };
  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaUiCliPath: _stellaUiCliPath,
    stellaComputerCliPath,
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

  let handlers: Record<string, ToolHandler> = mergeToolHandlers(
    createFilesystemToolHandlers(),
    createShellToolHandlers(shellState),
    createPatchToolHandlers(),
    createComputerHandlers({ stellaComputerCliPath }),
    createImageToolHandlers({ getStellaSiteAuth, queryConvex }),
    createDisplayToolHandlers({ displayHtml }),
    createWebToolHandlers({ webSearch }),
    createTaskToolHandlers(stateContext),
    createScheduleToolHandlers({ taskApi, scheduleApi }),
    createScheduleControlToolHandlers({ scheduleApi }),
    createAskQuestionToolHandlers(),
    ...(memoryStore ? [createMemoryToolHandlers({ memoryStore })] : []),
    createUserToolHandlers(userConfig),
  );

  let executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => Promise<ToolResult>;

  handlers = mergeToolHandlers(
    handlers,
    createParallelToolHandlers({
      executeTool: (toolName, toolArgs, context, signal, onUpdate) =>
        executeTool(toolName, toolArgs, context, signal, onUpdate),
    }),
  );

  registerExtensionToolHandlers(handlers, extensionTools);
  for (const tool of extensionTools ?? []) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }

  executeTool = async (
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
      args: toolArgs,
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
  };

  const getToolCatalog = (agentType?: string) =>
    Array.from(toolCatalog.values()).filter(
      (tool) =>
        agentType === AGENT_IDS.ORCHESTRATOR ||
        !ORCHESTRATOR_DIRECT_TOOL_NAMES.has(tool.name),
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
  };
};
