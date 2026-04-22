/**
 * Top-level handler registry for the device tool surface.
 *
 * Stella now uses a direct top-level tool surface:
 * - general execution tools are codex-style (`exec_command`, `apply_patch`, etc.)
 * - specialized/internal tools remain top-level for narrower agents
 * - orchestrator-only coordination tools stay top-level as well
 * - narrower specialist agents (Dream, Schedule) opt into dedicated tool
 *   allowlists on top of the same host
 */

import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type { MemoryStore, MemoryTarget } from "../memory/memory-store.js";
import { handleApplyPatch } from "./apply-patch.js";
import {
  createComputerToolHandlers,
  type CreateComputerToolHandlersOptions,
} from "./computer.js";
import { handleEdit, handleRead, handleWrite } from "./file.js";
import { localWebFetch } from "./local-tool-overrides.js";
import { createMediaToolHandlers } from "./media.js";
import { handleMultiToolUseParallel } from "./parallel.js";
import { handleGrep } from "./search.js";
import { handleSchedule } from "./schedule.js";
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
import {
  handleBash,
  handleExecCommand,
  handleKillShell,
  handleShellStatus,
  handleWriteStdin,
  type ShellState,
} from "./shell.js";
import {
  handleTask,
  handleTaskOutput,
  handleTaskUpdate,
  type StateContext,
} from "./state.js";
import type {
  ScheduleToolApi,
  TaskToolApi,
  ToolContext,
  ToolHandler,
  ToolResult,
  ToolUpdateCallback,
} from "./types.js";
import {
  handleAskUser,
  handleRequestCredential,
  type UserToolsConfig,
} from "./user.js";
import { handleViewImage } from "./view-image.js";
import type { ToolDefinition } from "../extensions/types.js";

export const mergeToolHandlers = (
  ...groups: Array<Record<string, ToolHandler>>
): Record<string, ToolHandler> => Object.assign({}, ...groups);

export const createUserToolHandlers = (
  userConfig: UserToolsConfig,
): Record<string, ToolHandler> => ({
  AskUserQuestion: (args, _context) => handleAskUser(args),
  RequestCredential: (args, _context) =>
    handleRequestCredential(userConfig, args),
});

export const createFilesystemToolHandlers = (): Record<string, ToolHandler> => ({
  Read: (args, context) => handleRead(args, context),
  Write: (args, context) => handleWrite(args, context),
  Edit: (args, context) => handleEdit(args, context),
  Grep: (args, context) => handleGrep(args, context),
});

export const createShellToolHandlers = (
  shellState: ShellState,
): Record<string, ToolHandler> => ({
  exec_command: (args, context, extras) =>
    handleExecCommand(shellState, args, context, extras?.signal),
  write_stdin: (args, context, extras) =>
    handleWriteStdin(shellState, args, context, extras?.signal),
  Bash: (args, context, extras) =>
    handleBash(shellState, args, context, extras?.signal),
  ShellStatus: (args) => handleShellStatus(shellState, args),
  KillShell: (args) => handleKillShell(shellState, args),
});

export const createPatchToolHandlers = (): Record<string, ToolHandler> => ({
  apply_patch: (args) => handleApplyPatch(args),
});

export const createComputerHandlers = (
  options: CreateComputerToolHandlersOptions,
): Record<string, ToolHandler> => createComputerToolHandlers(options);

export const createImageToolHandlers = (options: {
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  queryConvex?: (
    ref: unknown,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}): Record<string, ToolHandler> => ({
  view_image: (args, context) => handleViewImage(args, context),
  ...createMediaToolHandlers(options),
});

export const createParallelToolHandlers = (deps: {
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
}): Record<string, ToolHandler> => ({
  "multi_tool_use.parallel": (args, context, extras) =>
    handleMultiToolUseParallel(
      {
        executeTool: deps.executeTool,
      },
      args,
      context,
      extras,
    ),
});

const requireOrchestrator = (
  toolName: string,
  context: ToolContext,
): ToolResult | null =>
  context.agentType === AGENT_IDS.ORCHESTRATOR
    ? null
    : { error: `${toolName} is only available to the orchestrator.` };

const isMemoryTarget = (value: unknown): value is MemoryTarget =>
  value === "memory" || value === "user";

const isMemoryAction = (
  value: unknown,
): value is "add" | "replace" | "remove" =>
  value === "add" || value === "replace" || value === "remove";

export const createDisplayToolHandlers = (options: {
  displayHtml?: (html: string) => void;
}): Record<string, ToolHandler> => ({
  DisplayGuidelines: async (args, context) => {
    const denied = requireOrchestrator("DisplayGuidelines", context);
    if (denied) return denied;
    const modules = Array.isArray(args.modules) ? (args.modules as string[]) : [];
    if (!modules.length) return { error: "modules parameter is required." };
    try {
      const { getDisplayGuidelines } = await import("./display-guidelines.js");
      return { result: getDisplayGuidelines(modules) };
    } catch (error) {
      return { error: `Failed to load guidelines: ${(error as Error).message}` };
    }
  },
  Display: async (args, context) => {
    const denied = requireOrchestrator("Display", context);
    if (denied) return denied;
    if (!args.i_have_read_guidelines) {
      return {
        error:
          "You must call DisplayGuidelines before Display. Set i_have_read_guidelines: true after doing so.",
      };
    }
    const html = String(args.html ?? "");
    if (!html) return { error: "html parameter is required." };
    if (!options.displayHtml) {
      return { error: "Display is not available (no renderer connected)." };
    }
    options.displayHtml(html);
    return { result: "Display updated." };
  },
});

export const createWebToolHandlers = (options: {
  webSearch?: (
    query: string,
    options?: { category?: string },
  ) => Promise<{
    text: string;
    results?: Array<{ title: string; url: string; snippet: string }>;
  }>;
}): Record<string, ToolHandler> => ({
  web: async (args) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const prompt =
      typeof args.prompt === "string" ? args.prompt.trim() || undefined : undefined;

    if (!query && !url) {
      return { error: "Either query or url is required." };
    }
    if (query && url) {
      return { error: "Pass either query or url, not both." };
    }

    if (query) {
      if (!options.webSearch) {
        return { error: "web search is not available on this device." };
      }
      const category =
        typeof args.category === "string" ? args.category.trim() || undefined : undefined;
      try {
        const result = await options.webSearch(
          query,
          category ? { category } : undefined,
        );
        return {
          result: result.text || "No results found.",
          details: {
            mode: "search",
            query,
            ...(Array.isArray(result.results) ? { results: result.results } : {}),
          },
        };
      } catch (error) {
        return { error: `web search failed: ${(error as Error).message}` };
      }
    }

    const text = await localWebFetch({ url, ...(prompt ? { prompt } : {}) });
    return {
      result: text,
      details: { mode: "fetch", url, ...(prompt ? { prompt } : {}) },
    };
  },
});

export const createAskQuestionToolHandlers = (): Record<string, ToolHandler> => ({
  askQuestion: async (args, context) => {
    const denied = requireOrchestrator("askQuestion", context);
    if (denied) return denied;

    const rawQuestions = Array.isArray(args.questions) ? args.questions : null;
    if (!rawQuestions || rawQuestions.length === 0) {
      return { error: "questions array is required (at least one question)." };
    }

    const summary = rawQuestions
      .map((entry, qIndex) => {
        if (!entry || typeof entry !== "object") {
          return `Question ${qIndex + 1}: (invalid)`;
        }
        const record = entry as {
          question?: unknown;
          options?: unknown;
          allowOther?: unknown;
        };
        const question =
          typeof record.question === "string" ? record.question.trim() : "";
        if (!question) {
          return `Question ${qIndex + 1}: (missing question text)`;
        }
        const options = Array.isArray(record.options) ? record.options : [];
        const renderedOptions = options
          .map((option, oIndex) => {
            const label =
              option && typeof option === "object" &&
                typeof (option as { label?: unknown }).label === "string"
                ? ((option as { label: string }).label.trim() || "Option")
                : "Option";
            const letter = String.fromCharCode(65 + oIndex);
            return `  ${letter}. ${label}`;
          })
          .join("\n");
        const otherLine = record.allowOther
          ? `\n  ${String.fromCharCode(65 + options.length)}. Other... (free text)`
          : "";
        return `Question ${qIndex + 1}: ${question}\n${renderedOptions}${otherLine}`;
      })
      .join("\n\n");

    return {
      result:
        "Question tray rendered in chat. Wait for the user to answer before continuing.\n\n" +
        summary,
    };
  },
});

export const createTaskToolHandlers = (
  stateContext: StateContext,
): Record<string, ToolHandler> => ({
  TaskCreate: async (args, context) => {
    const denied = requireOrchestrator("TaskCreate", context);
    if (denied) return denied;
    return handleTask(stateContext, { ...args, action: "create" }, context);
  },
  TaskUpdate: async (args, context) => {
    const denied = requireOrchestrator("TaskUpdate", context);
    if (denied) return denied;
    return handleTaskUpdate(stateContext, args, context);
  },
  TaskPause: async (args, context) => {
    const denied = requireOrchestrator("TaskPause", context);
    if (denied) return denied;
    return handleTask(stateContext, { ...args, action: "cancel" }, context);
  },
  TaskOutput: async (args, context) => {
    const denied = requireOrchestrator("TaskOutput", context);
    if (denied) return denied;
    return handleTaskOutput(stateContext, args, context);
  },
});

export const createScheduleToolHandlers = (options: {
  taskApi?: TaskToolApi;
  scheduleApi?: ScheduleToolApi;
}): Record<string, ToolHandler> => ({
  Schedule: async (args, context) => {
    const denied = requireOrchestrator("Schedule", context);
    if (denied) return denied;
    try {
      return await handleSchedule(options.taskApi, args, context);
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

export const createScheduleControlToolHandlers = (options: {
  scheduleApi?: ScheduleToolApi;
}): Record<string, ToolHandler> => ({
  HeartbeatGet: async (args, context) =>
    await handleHeartbeatGet(options.scheduleApi, args, context),
  HeartbeatUpsert: async (args, context) =>
    await handleHeartbeatUpsert(options.scheduleApi, args, context),
  HeartbeatRun: async (args, context) =>
    await handleHeartbeatRun(options.scheduleApi, args, context),
  CronList: async () => await handleCronList(options.scheduleApi),
  CronAdd: async (args, context) =>
    await handleCronAdd(options.scheduleApi, args, context),
  CronUpdate: async (args) =>
    await handleCronUpdate(options.scheduleApi, args),
  CronRemove: async (args) =>
    await handleCronRemove(options.scheduleApi, args),
  CronRun: async (args) =>
    await handleCronRun(options.scheduleApi, args),
});

export const createMemoryToolHandlers = (options: {
  memoryStore: MemoryStore;
}): Record<string, ToolHandler> => ({
  Memory: async (args, context) => {
    const denied = requireOrchestrator("Memory", context);
    if (denied) return denied;
    const action = isMemoryAction(args.action) ? args.action : null;
    const target = isMemoryTarget(args.target) ? args.target : null;
    if (!action) {
      return { error: "action must be one of: add, replace, remove." };
    }
    if (!target) {
      return { error: "target must be one of: memory, user." };
    }
    const content = typeof args.content === "string" ? args.content : "";
    const oldText = typeof args.oldText === "string" ? args.oldText : "";

    if (action === "add") {
      return { result: options.memoryStore.add(target, content) };
    }
    if (action === "replace") {
      return { result: options.memoryStore.replace(target, oldText, content) };
    }
    return { result: options.memoryStore.remove(target, oldText) };
  },
});

export const registerExtensionToolHandlers = (
  handlers: Record<string, ToolHandler>,
  extensionTools?: ToolDefinition[],
): void => {
  if (!extensionTools) return;
  for (const tool of extensionTools) {
    handlers[tool.name] = (args, context) => tool.execute(args, context);
  }
};
