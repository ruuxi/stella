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
import {
  AGENT_IDS,
  getAgentDefinition,
} from "../../contracts/agent-runtime.js";

import type { Api, Model } from "../../ai/types.js";
import {
  APPLY_PATCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  type FileEditAgentEngine,
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
import {
  createShellState,
  drainCompletedProducedFiles,
  type ShellState,
} from "./shell.js";
import { createStateContext, type StateContext } from "./state.js";
import {
  createShellToolHandlers,
  mergeToolHandlers,
  registerExtensionToolHandlers,
} from "./registry.js";
import { buildBuiltinTools } from "./defs/index.js";
import type { ToolDefinition as BuiltinToolDefinition } from "./types.js";
import { sanitizeToolError, sanitizeToolResult } from "./safety.js";

import type { ToolDefinition } from "../extensions/types.js";

export type { ToolContext, ToolHandlerExtras, ToolResult };

export type ToolHost = ReturnType<typeof createToolHost>;

export const createToolHost = ({
  stellaAppDir,
  stellaDataDir,
  stellaBrowserBinPath: _stellaBrowserBinPath,
  stellaOfficeBinPath: _stellaOfficeBinPath,
  stellaComputerCliPath,
  stellaConnectCliPath,
  stellaMediaCliPath,
  stellaXApiCliPath,
  cliBridgeSocketPath,
  requestCredential,
  agentApi,
  sourceImportApi,
  validateSpawnModel,
  scheduleApi,

  fashionApi,
  extensionTools,
  webSearch,
  getStellaSiteAuth,
  queryConvex,
  actionConvex,
  contextProvider,
}: ToolHostOptions) => {
  const stateRoot = stellaDataDir ?? stellaAppDir;
  const toolCatalog = new Map<string, ToolMetadata>();

  const shellState: ShellState = createShellState(stateRoot, {
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaConnectCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    getStellaSiteAuth,
    cliBridgeSocketPath,
  });
  const stateContext: StateContext = createStateContext(
    stateRoot,
    agentApi,
    validateSpawnModel,
  );

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
    stellaAppDir,
    stellaDataDir: stateRoot,
    stellaBrowserBinPath: _stellaBrowserBinPath,
    stellaOfficeBinPath: _stellaOfficeBinPath,
    stellaComputerCliPath,
    stellaConnectCliPath,
    stellaMediaCliPath,
    stellaXApiCliPath,
    requestCredential,
    agentApi,
    sourceImportApi,
    scheduleApi,

    fashionApi,
    extensionTools,
    webSearch,
    getStellaSiteAuth,
    queryConvex,
    actionConvex,
    contextProvider,
    shellState,
    stateContext,
    executeTool: (toolName, toolArgs, context, signal, onUpdate) =>
      executeTool(toolName, toolArgs, context, signal, onUpdate),
  });
  // Names of built-in tools live in a dedicated Set so the
  // extension-registration paths below can reject collisions instead
  // of silently overwriting handlers. Without this guard, an extension
  // that registers `web` or `exec_command` would replace the built-in
  // implementation; on F1 reload `unregisterExtensionTools` would then
  // delete the name entirely, leaving the runtime without a built-in
  // handler until the worker restarts.
  const builtinToolNames = new Set<string>();
  for (const tool of builtinTools) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      ...(tool.label ? { label: tool.label } : {}),
      ...(tool.workingText ? { workingText: tool.workingText } : {}),
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.deferred ? { deferred: tool.deferred } : {}),
      ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
    });
    handlers[tool.name] = (args, context, extras) =>
      tool.execute(args, context, extras);
    builtinToolNames.add(tool.name);
  }

  // Filter out any startup-time `extensionTools` that collide with
  // built-ins before letting them touch the catalog or handler map.
  // Same policy as the runtime `registerExtensionTools` below.
  const acceptedStartupExtensionTools = (extensionTools ?? []).filter(
    (tool) => {
      if (builtinToolNames.has(tool.name)) {
        logError(
          `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
        );
        return false;
      }
      return true;
    },
  );
  registerExtensionToolHandlers(handlers, acceptedStartupExtensionTools);
  for (const tool of acceptedStartupExtensionTools) {
    toolCatalog.set(tool.name, {
      name: tool.name,
      ...(tool.label ? { label: tool.label } : {}),
      ...(tool.workingText ? { workingText: tool.workingText } : {}),
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.deferred ? { deferred: tool.deferred } : {}),
      ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
    });
  }

  /**
   * Defense-in-depth gate consulted both at catalog filter time and at
   * executeTool time. A tool with no `agentTypes` is unrestricted; a tool
   * with `agentTypes` must list the requesting agent or it's denied.
   */
  const isAgentAllowedForTool = (
    tool: { agentTypes?: readonly string[] },
    agentType: string | undefined,
  ): boolean => {
    if (!tool.agentTypes || tool.agentTypes.length === 0) return true;
    if (!agentType) return false;
    return tool.agentTypes.includes(agentType);
  };

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

    // Declarative agent-type gate. Mirrors the catalog filter so a tool that
    // declares `agentTypes` is rejected here too, defending against
    // hallucinated tool names and against any future catalog filter bypass.
    const catalogEntry = toolCatalog.get(toolName);
    if (
      catalogEntry &&
      !isAgentAllowedForTool(catalogEntry, context.agentType)
    ) {
      const allowed = catalogEntry.agentTypes ?? [];
      // Format the denial message to match historical per-agent wording.
      // Pre-migration the orchestrator helper read "only available to the
      // orchestrator" (lowercase agent id, no " agent" suffix) and the
      // Fashion helper read "only available to the Fashion agent." (capitalized
      // display name, " agent" suffix). Use the agent definition's `name`
      // field so the Fashion path doesn't degrade to "the fashion." (broken
      // grammar, leaked internal id) — but special-case the orchestrator so
      // existing UI/error consumers and tests pinning that exact substring
      // keep working.
      const formatAllowedAgent = (id: string): string => {
        if (id === AGENT_IDS.ORCHESTRATOR) return "the orchestrator";
        const def = getAgentDefinition(id);
        return def?.name ? `the ${def.name} agent` : `the ${id} agent`;
      };
      const formatted =
        allowed.length === 1
          ? formatAllowedAgent(allowed[0]!)
          : allowed.map(formatAllowedAgent).join(", ");
      return {
        error: `${toolName} is only available to ${formatted}.`,
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
      const result = sanitizeToolResult(
        await handler(toolArgs, context, extras),
      );
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
      return {
        error: sanitizeToolError(
          `Tool ${toolName} failed: ${(error as Error).message}`,
        ),
      };
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
    options?: {
      model?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
      agentEngine?: FileEditAgentEngine;
      includeDeferred?: boolean;
    },
  ) => {
    const fileEditToolFamily = getFileEditToolFamily({
      agentType,
      model: options?.model,
      agentEngine: options?.agentEngine,
    });
    return Array.from(toolCatalog.values())
      .filter((tool) => {
        // A tool's `agentTypes` is the single audience gate: a tool with no
        // `agentTypes` is available to every agent, and the per-agent
        // frontmatter `tools:` allowlist (applied downstream in
        // tool-adapters) decides what each agent is actually offered.
        if (!isAgentAllowedForTool(tool, agentType)) return false;
        if (tool.deferred && options?.includeDeferred !== true) return false;
        // Swap the file-edit tool family to the agent's engine: Claude Code
        // wants Write/Edit, Stella wants apply_patch.
        if (
          fileEditToolFamily === "write_edit" &&
          tool.name === APPLY_PATCH_TOOL_NAME
        ) {
          return false;
        }
        if (
          fileEditToolFamily === "apply_patch" &&
          (tool.name === WRITE_TOOL_NAME || tool.name === EDIT_TOOL_NAME)
        ) {
          return false;
        }
        return true;
      });
  };

  // Track tool names that came from user-installable extensions so a
  // reload (F1) can sweep them without touching built-in tools. The Set
  // is rebuilt on every successful `registerExtensionTools` call.
  const extensionToolNames = new Set<string>();

  return {
    executeTool,
    getToolCatalog,
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    // Pull deliverables from background/long-running shell sessions that
    // finished after their last poll (so their produced files were never
    // drained inline) into the agent-completed rollup. Optionally scoped to
    // the sessions a run touched.
    drainCompletedShellProducedFiles: (sessionIds?: string[]) =>
      drainCompletedProducedFiles(shellState, sessionIds),
    killAllShells,
    killShell,
    killShellsByPort,
    shutdown,
    registerExtensionTools: (tools: ToolDefinition[]) => {
      // Reject tools that collide with built-in names. Pre-fix, an
      // extension registering e.g. `web` or `exec_command` would
      // overwrite the built-in handler/catalog entry AND get tracked in
      // `extensionToolNames`. On F1 reload `unregisterExtensionTools`
      // would then `delete` that name from both maps, leaving the
      // runtime without a built-in until worker restart. Skipping the
      // collision keeps the built-in intact — the right user fix is to
      // rename the extension tool.
      const accepted: ToolDefinition[] = [];
      for (const tool of tools) {
        if (builtinToolNames.has(tool.name)) {
          logError(
            `Extension tool "${tool.name}" collides with a built-in tool name; skipping registration. Rename the extension tool to avoid the collision.`,
          );
          continue;
        }
        accepted.push(tool);
      }
      registerExtensionToolHandlers(handlers, accepted);
      for (const tool of accepted) {
        toolCatalog.set(tool.name, {
          name: tool.name,
          ...(tool.label ? { label: tool.label } : {}),
          ...(tool.workingText ? { workingText: tool.workingText } : {}),
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.deferred ? { deferred: tool.deferred } : {}),
          ...(tool.agentTypes ? { agentTypes: tool.agentTypes } : {}),
        });
        extensionToolNames.add(tool.name);
      }
    },
    /**
     * Remove all tools that came from user-installable extensions. Used by
     * F1 (extension hot-reload) before re-registering the freshly-loaded
     * extension set; built-in tools remain in the catalog and handler
     * maps untouched.
     */
    unregisterExtensionTools: () => {
      for (const name of extensionToolNames) {
        toolCatalog.delete(name);
        delete handlers[name];
      }
      extensionToolNames.clear();
    },
  };
};
