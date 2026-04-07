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
 * - tools-shell.ts    — Bash, SkillBash handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — TaskCreate/TaskPause, TaskUpdate, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */

import path from "path";

// Types
import type {
  ToolContext,
  ToolResult,
  ToolHostOptions,
  SkillRecord,
  SecretMountSpec,
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

import type { ToolDefinition } from "../extensions/types.js";

// Re-export types for external consumers
export type { ToolContext, ToolResult };

export const createToolHost = ({
  stellaHomePath,
  frontendRoot,
  stellaBrowserBinPath,
  stellaOfficeBinPath,
  stellaUiCliPath,
  requestCredential,
  resolveSecret,
  taskApi,
  scheduleApi,
  extensionTools,
  displayHtml,
}: ToolHostOptions) => {
  const stateRoot = path.join(stellaHomePath, "state");
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
  setFileToolsConfig({ frontendRoot });

  // User tools config
  const userConfig: UserToolsConfig = { requestCredential };

  // Secret resolution helper for shell tools
  const resolveSecretValue = async (
    spec: SecretMountSpec,
    cache: Map<string, string>,
    context?: ToolContext,
    toolName?: string,
  ): Promise<string | null> => {
    if (cache.has(spec.provider)) {
      return cache.get(spec.provider) ?? null;
    }
    if (!resolveSecret) return null;

    let resolved = await resolveSecret({
      provider: spec.provider,
      requestId: context?.requestId,
      toolName,
      deviceId: context?.deviceId,
    });
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
        requestId: context?.requestId,
        toolName,
        deviceId: context?.deviceId,
      });
    }

    if (!resolved) return null;
    cache.set(spec.provider, resolved.plaintext);
    return resolved.plaintext;
  };

  // Initialize shell and state contexts
  const shellState: ShellState = createShellState(resolveSecretValue, stateRoot, {
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

  const setSkills = (skills: SkillRecord[]) => {
    shellState.skillCache = skills;
  };

  const handlers = mergeToolHandlers(
    createFileToolHandlers(),
    createSearchToolHandlers(),
    createShellToolHandlers(shellState),
    createTaskToolHandlers(stateContext),
    createUserToolHandlers(userConfig),
    createDisplayToolHandlers({ displayHtml }),
    createScheduleToolHandlers({ taskApi, scheduleApi }),
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
  ) => {
    log(`Executing tool: ${toolName}`, {
      args: toolName.includes("hera-browser")
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
    setSkills,
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
