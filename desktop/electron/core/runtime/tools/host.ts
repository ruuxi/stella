/**
 * Tool host factory and registry.
 *
 * This module creates the tool execution environment and composes all tool handlers.
 * Individual tool implementations are split into domain-specific files:
 *
 * - tools-types.ts    — Shared type definitions
 * - tools-utils.ts    — Shared utilities (logging, path expansion, truncation, etc.)
 * - tools-file.ts     — Read, Edit handlers
 * - tools-search.ts   — Glob, Grep handlers
 * - tools-shell.ts    — Bash, SkillBash handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — Task, TaskOutput handlers
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
} from "./types.js";

// Utilities
import { log, logError, recoverStaleSecretFiles } from "./utils.js";

// Tool handlers
import { handleRead, handleWrite, handleEdit, setFileToolsConfig } from "./file.js";
import { handleGlob, handleGrep } from "./search.js";
import {
  createShellState,
  handleBash,
  handleKillShell,
  handleShellStatus,
  handleSkillBash,
  type ShellState,
} from "./shell.js";
// WebFetch and WebSearch have been promoted to backend tools (Convex actions).
// import { handleWebFetch, handleWebSearch } from "./tools-web.js";
import {
  createStateContext,
  handleTask,
  handleTaskOutput,
  type StateContext,
} from "./state.js";
import { handleAskUser, handleRequestCredential, type UserToolsConfig } from "./user.js";
import {
  handleCronAdd,
  handleCronList,
  handleCronRemove,
  handleCronRun,
  handleCronUpdate,
  handleHeartbeatGet,
  handleHeartbeatRun,
  handleHeartbeatUpsert,
} from "./schedule.js";

import type { ToolDefinition } from "../extensions/types.js";

// Re-export types for external consumers
export type { ToolContext, ToolResult };

export const createToolHost = ({
  StellaHome,
  frontendRoot,
  stellaBrowserBinPath,
  stellaUiCliPath,
  requestCredential,
  resolveSecret,
  taskApi,
  scheduleApi,
  extensionTools,
  displayHtml,
}: ToolHostOptions) => {
  const stateRoot = path.join(StellaHome, "state");

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

  const notConfigured = (name: string): ToolResult => ({
    result: `${name} is not configured on this device yet.`,
  });

  // Handler registry
  const handlers: Record<
    string,
    (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
  > = {
    // File tools
    Read: (args, context) => handleRead(args, context),
    Write: (args, context) => handleWrite(args, context),
    Edit: (args, context) => handleEdit(args, context),

    // Search tools
    Glob: (args) => handleGlob(args),
    Grep: (args) => handleGrep(args),

    // Shell tools
    Bash: (args, context) => handleBash(shellState, args, context),
    KillShell: (args) => handleKillShell(shellState, args),
    ShellStatus: (args) => handleShellStatus(shellState, args),
    SkillBash: (args, context) => handleSkillBash(shellState, args, context),

    // State tools
    Task: (args, context) => handleTask(stateContext, args, context),
    TaskCreate: (args, context) =>
      handleTask(
        stateContext,
        { ...args, action: "create" },
        context,
      ),
    TaskCancel: (args, context) =>
      handleTask(
        stateContext,
        { ...args, action: "cancel" },
        context,
      ),
    TaskOutput: (args, context) => handleTaskOutput(stateContext, args, context),

    // User tools
    AskUserQuestion: (args) => handleAskUser(args),
    RequestCredential: (args) => handleRequestCredential(userConfig, args),

    // Display guidelines tool
    DisplayGuidelines: async (args) => {
      const modules = (args.modules as string[]) ?? [];
      if (!modules.length) return { error: "modules parameter is required." };
      try {
        const { getDisplayGuidelines } = await import("./display-guidelines.js");
        const guidelines = getDisplayGuidelines(modules);
        return { result: guidelines };
      } catch (error) {
        return { error: `Failed to load guidelines: ${(error as Error).message}` };
      }
    },

    // Display tool
    Display: async (args) => {
      if (!args.i_have_read_guidelines) {
        return { error: "You must call DisplayGuidelines before Display. Set i_have_read_guidelines: true after doing so." };
      }
      const html = String(args.html ?? "");
      if (!html) return { error: "html parameter is required." };
      if (displayHtml) {
        displayHtml(html);
        return { result: "Display updated." };
      }
      return { error: "Display is not available (no renderer connected)." };
    },

    // Media tools (not yet implemented)
    MediaGenerate: async () => notConfigured("MediaGenerate"),
    HeartbeatGet: (args, context) => handleHeartbeatGet(scheduleApi, args, context),
    HeartbeatUpsert: (args, context) => handleHeartbeatUpsert(scheduleApi, args, context),
    HeartbeatRun: (args, context) => handleHeartbeatRun(scheduleApi, args, context),
    CronList: () => handleCronList(scheduleApi),
    CronAdd: (args, context) => handleCronAdd(scheduleApi, args, context),
    CronUpdate: (args) => handleCronUpdate(scheduleApi, args),
    CronRemove: (args) => handleCronRemove(scheduleApi, args),
    CronRun: (args) => handleCronRun(scheduleApi, args),

  };

  // Register extension tools
  if (extensionTools) {
    for (const tool of extensionTools) {
      handlers[tool.name] = (args, context) => tool.execute(args, context);
    }
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
    getHandlerNames: () => Object.keys(handlers),
    getShells: () => Array.from(shellState.shells.values()),
    killAllShells,
    killShellsByPort,
    setSkills,
    registerExtensionTools: (tools: ToolDefinition[]) => {
      for (const tool of tools) {
        handlers[tool.name] = (args, context) => tool.execute(args, context);
      }
    },
  };
};
