/**
 * Tool host factory.
 *
 * Builds the tool execution environment for a Stella session.
 *
 * Every model-facing tool lives as a self-contained `ToolDefinition` under
 * `runtime/kernel/tools/defs/`. `buildBuiltinTools()` returns the full set;
 * the host indexes them by name into a single Map that drives both:
 *
 *   - the catalog the model sees (`getToolCatalog`)
 *   - the handler dispatcher (`executeTool`)
 *
 * The legacy companion handlers (Bash / ShellStatus / KillShell, plus
 * extension-injected ToolDefinitions) sit alongside in the same map.
 */

import path from "node:path";
import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";

import type {
  Api,
  Model,
} from "../../ai/types.js";
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  getFileEditToolFamily,
  WRITE_TOOL_NAME,
} from "./file-edit-policy.js";
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
import { createShellState, type ShellState } from "./shell.js";
import { createStateContext, type StateContext } from "./state.js";
import {
  createShellToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { buildBuiltinTools } from "./defs/index.js";
import type { ToolDefinition as BuiltinToolDefinition } from "./types.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

const ORCHESTRATOR_DIRECT_TOOL_NAMES = new Set([
  "Display",
  "DisplayGuidelines",
  "Schedule",
  "Store",
  "spawn_agent",
  "send_input",
  "pause_agent",
  "Memory",
  "askQuestion",
]);

const SOCIAL_SESSION_TOOL_NAMES = new Set([
  "Read",
  "Grep",
  APPLY_PATCH_TOOL_NAME,
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  "multi_tool_use_parallel",
]);

const WORKER_ONLY_TOOL_NAMES = new Set(["MCP"]);

const GENERAL_EXCLUDED_TOOL_NAMES = new Set(["image_gen"]);

const SUBAGENT_USER_FACING_TOOL_NAMES: Record<string, ReadonlySet<string>> = {};

export const createToolHost = ({
  stellaRoot,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaUiCliPath: _stellaUiCliPath,
  stellaComputerCliPath,
  requestCredential,
  agentApi,
  scheduleApi,

  fashionApi,
  extensionTools,
  displayHtml,
  webSearch,
  getStellaSiteAuth,
  queryConvex,
  memoryStore,
  notifyVoiceActionComplete,
}: ToolHostOptions) => {
  const stateRoot = path.join(stellaRoot, "state");
  const toolCatalog = new Map<string, ToolMetadata>();

  setFileToolsConfig({ stellaRoot });

  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaUiCliPath: _stellaUiCliPath,
    stellaComputerCliPath,
  });
  const stateContext: StateContext = createStateContext(stateRoot, agentApi);

  void recoverStaleSecretFiles(stateRoot)
    .then((result) => {
      if (result.recovered > 0 || result.skipped > 0) {
        log("Recovered stale secret mounts", result);
      }
    })
    .catch((error) => {
      logError("Failed to recover stale secret mounts", error);
    });

  // Legacy companion handlers (no schema in the catalog; reachable only by
  // direct executeTool calls from non-model code paths). These predate the
  // def-driven surface and stay until their callers are folded in.
  const handlers: Record<string, ToolHandler> = mergeToolHandlers(
    createShellToolHandlers(shellState),
  );

  let executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolHandlerExtras["onUpdate"],
  ) => Promise<ToolResult>;

  // Built-in def-driven tools. Each `defs/<name>.ts` owns its own schema +
  // description + handler; they're the single source of truth for everything
  // the model sees.
  const builtinTools: BuiltinToolDefinition[] = buildBuiltinTools({
    stellaRoot,
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaUiCliPath: _stellaUiCliPath,
    stellaComputerCliPath,
    requestCredential,
    agentApi,
    scheduleApi,

    fashionApi,
    extensionTools,
    displayHtml,
    webSearch,
    getStellaSiteAuth,
    queryConvex,
    memoryStore,
    notifyVoiceActionComplete,
    shellState,
    stateContext,
    executeTool: (toolName, toolArgs, context, signal, onUpdate) =>
      executeTool(toolName, toolArgs, context, signal, onUpdate),
  });
  for (const tool of builtinTools) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    handlers[tool.name] = (args, context, extras) =>
      tool.execute(args, context, extras);
  }

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

    if (
      context.agentType === AGENT_IDS.GENERAL &&
      GENERAL_EXCLUDED_TOOL_NAMES.has(toolName)
    ) {
      return {
        error: `${toolName} is not available to the General agent.`,
      } satisfies ToolResult;
    }

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

  const killShell = async (sessionId: string) => {
    const shell = shellState.shells.get(sessionId);
    if (!shell) return;
    if (shell.running) {
      shell.kill();
    }
    const deadline = Date.now() + 1_500;
    while (shell.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const shutdown = async () => {
    killAllShells();
  };

  const getToolCatalog = (
    agentType?: string,
    options?: { model?: Pick<Model<Api>, "api" | "provider" | "id" | "name"> },
  ) => {
    const subagentExtras = agentType
      ? SUBAGENT_USER_FACING_TOOL_NAMES[agentType]
      : undefined;
    const fileEditToolFamily = getFileEditToolFamily({
      agentType,
      model: options?.model,
    });
    return Array.from(toolCatalog.values()).filter((tool) =>
      fileEditToolFamily === "write_edit" &&
      tool.name === APPLY_PATCH_TOOL_NAME
        ? false
        : fileEditToolFamily === "apply_patch" &&
            (tool.name === WRITE_TOOL_NAME || tool.name === EDIT_TOOL_NAME)
          ? false
          : agentType === AGENT_IDS.GENERAL &&
              GENERAL_EXCLUDED_TOOL_NAMES.has(tool.name)
            ? false
            : WORKER_ONLY_TOOL_NAMES.has(tool.name) &&
                agentType !== AGENT_IDS.GENERAL
              ? false
              : agentType === AGENT_IDS.SOCIAL_SESSION
                ? SOCIAL_SESSION_TOOL_NAMES.has(tool.name)
                : agentType === AGENT_IDS.ORCHESTRATOR ||
                  (subagentExtras !== undefined &&
                    subagentExtras.has(tool.name)) ||
                  !ORCHESTRATOR_DIRECT_TOOL_NAMES.has(tool.name),
    );
  };

  return {
    executeTool,
    getToolCatalog,
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    killAllShells,
    killShell,
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
