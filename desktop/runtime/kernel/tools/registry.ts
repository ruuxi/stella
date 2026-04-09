import type { ToolHandler } from "./types.js";
import {
  handleRead,
  handleWrite,
  handleEdit,
} from "./file.js";
import { handleGrep } from "./search.js";
import {
  handleBash,
  handleKillShell,
  handleShellStatus,
  type ShellState,
} from "./shell.js";
import {
  handleTask,
  handleTaskOutput,
  handleTaskUpdate,
  type StateContext,
} from "./state.js";
import {
  handleAskUser,
  handleRequestCredential,
  type UserToolsConfig,
} from "./user.js";
import {
  handleCronAdd,
  handleCronList,
  handleCronRemove,
  handleCronRun,
  handleCronUpdate,
  handleHeartbeatGet,
  handleHeartbeatRun,
  handleHeartbeatUpsert,
  handleSchedule,
} from "./schedule.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { ScheduleToolApi, TaskToolApi } from "./types.js";

export const mergeToolHandlers = (
  ...groups: Array<Record<string, ToolHandler>>
): Record<string, ToolHandler> => Object.assign({}, ...groups);

export const createFileToolHandlers = (): Record<string, ToolHandler> => ({
  Read: (args, context) => handleRead(args, context),
  Write: (args, context) => handleWrite(args, context),
  Edit: (args, context) => handleEdit(args, context),
});

export const createSearchToolHandlers = (): Record<string, ToolHandler> => ({
  Grep: (args, context) => handleGrep(args, context),
});

export const createShellToolHandlers = (
  shellState: ShellState,
): Record<string, ToolHandler> => ({
  Bash: (args, context) => handleBash(shellState, args, context),
  KillShell: (args, _context) => handleKillShell(shellState, args),
  ShellStatus: (args, _context) => handleShellStatus(shellState, args),
});

export const createTaskToolHandlers = (
  stateContext: StateContext,
): Record<string, ToolHandler> => ({
  TaskUpdate: (args, context) => handleTaskUpdate(stateContext, args, context),
  TaskCreate: (args, context) =>
    handleTask(stateContext, { ...args, action: "create" }, context),
  TaskPause: (args, context) =>
    handleTask(stateContext, { ...args, action: "cancel" }, context),
  TaskOutput: (args, context) => handleTaskOutput(stateContext, args, context),
});

export const createUserToolHandlers = (
  userConfig: UserToolsConfig,
): Record<string, ToolHandler> => ({
  AskUserQuestion: (args, _context) => handleAskUser(args),
  RequestCredential: (args, _context) =>
    handleRequestCredential(userConfig, args),
});

export const createDisplayToolHandlers = (options: {
  displayHtml?: (html: string) => void;
}): Record<string, ToolHandler> => ({
  DisplayGuidelines: async (args) => {
    const modules = (args.modules as string[]) ?? [];
    if (!modules.length) return { error: "modules parameter is required." };
    try {
      const { getDisplayGuidelines } = await import("./display-guidelines.js");
      return { result: getDisplayGuidelines(modules) };
    } catch (error) {
      return { error: `Failed to load guidelines: ${(error as Error).message}` };
    }
  },
  Display: async (args) => {
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

export const createScheduleToolHandlers = (options: {
  taskApi?: TaskToolApi;
  scheduleApi?: ScheduleToolApi;
}): Record<string, ToolHandler> => {
  return {
    Schedule: (args, context) => handleSchedule(options.taskApi, args, context),
    HeartbeatGet: (args, context) =>
      handleHeartbeatGet(options.scheduleApi, args, context),
    HeartbeatUpsert: (args, context) =>
      handleHeartbeatUpsert(options.scheduleApi, args, context),
    HeartbeatRun: (args, context) =>
      handleHeartbeatRun(options.scheduleApi, args, context),
    CronList: async (_args, _context) => handleCronList(options.scheduleApi),
    CronAdd: (args, context) => handleCronAdd(options.scheduleApi, args, context),
    CronUpdate: (args, _context) => handleCronUpdate(options.scheduleApi, args),
    CronRemove: (args, _context) => handleCronRemove(options.scheduleApi, args),
    CronRun: (args, _context) => handleCronRun(options.scheduleApi, args),
  };
};

export const registerExtensionToolHandlers = (
  handlers: Record<string, ToolHandler>,
  extensionTools?: ToolDefinition[],
): void => {
  if (!extensionTools) {
    return;
  }
  for (const tool of extensionTools) {
    handlers[tool.name] = (args, context) => tool.execute(args, context);
  }
};
