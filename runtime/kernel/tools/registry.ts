/**
 * Top-level handler registry for the device tool surface.
 *
 * Stella uses a hybrid model:
 * - the Orchestrator keeps a small direct coordination surface
 * - the General agent stays Exec-first
 * - internal subagents (`Explore`) still reach `Read` / `Grep` directly
 */

import { AGENT_IDS } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import type { MemoryStore, MemoryTarget } from "../memory/memory-store.js";
import { handleRead } from "./file.js";
import { localWebFetch } from "./local-tool-overrides.js";
import { handleGrep } from "./search.js";
import { handleSchedule } from "./schedule.js";
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
} from "./types.js";
import {
  handleAskUser,
  handleRequestCredential,
  type UserToolsConfig,
} from "./user.js";
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
  ) => Promise<{ text: string }>;
}): Record<string, ToolHandler> => ({
  WebSearch: async (args, context) => {
    const denied = requireOrchestrator("WebSearch", context);
    if (denied) return denied;
    if (!options.webSearch) {
      return { error: "WebSearch is not available on this device." };
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { error: "query is required." };
    }
    const category =
      typeof args.category === "string" ? args.category.trim() || undefined : undefined;
    try {
      const result = await options.webSearch(
        query,
        category ? { category } : undefined,
      );
      return { result: result.text || "No results found." };
    } catch (error) {
      return { error: `WebSearch failed: ${(error as Error).message}` };
    }
  },
  WebFetch: async (args, context) => {
    const denied = requireOrchestrator("WebFetch", context);
    if (denied) return denied;
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return { error: "url is required." };
    }
    const prompt =
      typeof args.prompt === "string" ? args.prompt.trim() || undefined : undefined;
    const text = await localWebFetch({ url, ...(prompt ? { prompt } : {}) });
    return { result: text };
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

/**
 * Internal-only handlers used by the Explore subagent. These are not part of
 * the model-facing tool catalog; they're reachable via `executeTool` only.
 */
export const createInternalExploreHandlers = (): Record<string, ToolHandler> => ({
  Read: (args, context) => handleRead(args, context),
  Grep: (args, context) => handleGrep(args, context),
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
