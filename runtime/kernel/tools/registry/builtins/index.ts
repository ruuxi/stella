/**
 * Convenience aggregator: builds the full Stella built-in tool set for the
 * Exec registry given the host options. Individual builtins live in sibling
 * files and can be registered piecemeal when only a subset is needed.
 */

import type { MemoryStore } from "../../../memory/memory-store.js";
import type { StateContext } from "../../state.js";
import type {
  ScheduleToolApi,
  TaskToolApi,
} from "../../types.js";
import type { ShellState } from "../../shell.js";
import type {
  ExecToolDefinition,
  ExecToolRegistry,
} from "../registry.js";
import { createApplyPatchBuiltin } from "./apply-patch.js";
import { createDescribeBuiltin } from "./describe.js";
import { createDisplayBuiltins } from "./display.js";
import { createFileBuiltins } from "./file.js";
import { createMemoryBuiltins } from "./memory.js";
import { createScheduleBuiltins } from "./schedule.js";
import { createShellBuiltins } from "./shell.js";
import { createTaskBuiltins } from "./task.js";
import { createWebBuiltins, type WebSearchHandler } from "./web.js";

const ORCHESTRATOR_TOOL_AGENT_TYPES = ["orchestrator"] as const;
const ORCHESTRATOR_AND_SCHEDULE_TOOL_AGENT_TYPES = [
  "orchestrator",
  "schedule",
] as const;

export type CreateBuiltinsOptions = {
  shellState: ShellState;
  stateContext: StateContext;
  scheduleApi?: ScheduleToolApi;
  taskApi?: TaskToolApi;
  memoryStore?: MemoryStore;
  displayHtml?: (html: string) => void;
  webSearch?: WebSearchHandler;
};

export const createAllBuiltins = (
  options: CreateBuiltinsOptions,
): ExecToolDefinition[] => {
  const tools: ExecToolDefinition[] = [];
  tools.push(...createFileBuiltins());
  tools.push(createApplyPatchBuiltin());
  tools.push(...createShellBuiltins(options.shellState));
  tools.push(...createWebBuiltins({ webSearch: options.webSearch }));
  tools.push(
    ...createDisplayBuiltins({
      ...(options.displayHtml ? { displayHtml: options.displayHtml } : {}),
    }).map((tool) => ({
      ...tool,
      agentTypes: ORCHESTRATOR_TOOL_AGENT_TYPES,
    })),
  );
  tools.push(
    ...createTaskBuiltins({
      stateContext: options.stateContext,
      agentTypes: ORCHESTRATOR_TOOL_AGENT_TYPES,
    }),
  );
  // Heartbeat + cron tools are visible to both the orchestrator (delegates
  // via `tools.schedule`) and the schedule subagent (which applies the
  // changes). `tools.schedule` itself is orchestrator-only to prevent the
  // schedule subagent from recursively delegating to itself.
  tools.push(
    ...createScheduleBuiltins({
      ...(options.scheduleApi ? { scheduleApi: options.scheduleApi } : {}),
      ...(options.taskApi ? { taskApi: options.taskApi } : {}),
      agentTypes: ORCHESTRATOR_AND_SCHEDULE_TOOL_AGENT_TYPES,
      scheduleDelegateAgentTypes: ORCHESTRATOR_TOOL_AGENT_TYPES,
    }),
  );
  if (options.memoryStore) {
    tools.push(
      ...createMemoryBuiltins({
        memoryStore: options.memoryStore,
        agentTypes: ORCHESTRATOR_TOOL_AGENT_TYPES,
      }),
    );
  }
  return tools;
};

/**
 * `tools.describe` is registered separately because it needs a back-reference
 * to the registry. Call this AFTER `createAllBuiltins` (and any extension
 * tools) so it sees the full live tool set.
 */
export const registerDescribeBuiltin = (
  registry: ExecToolRegistry,
): void => {
  registry.register(createDescribeBuiltin({ registry }));
};

export {
  createApplyPatchBuiltin,
  createDescribeBuiltin,
  createDisplayBuiltins,
  createFileBuiltins,
  createMemoryBuiltins,
  createScheduleBuiltins,
  createShellBuiltins,
  createTaskBuiltins,
  createWebBuiltins,
};
