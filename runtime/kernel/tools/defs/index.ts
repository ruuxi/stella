/**
 * Built-in tool definitions.
 *
 * One file per tool under this directory exports either:
 *   - a `ToolDefinition` directly (stateless tools), or
 *   - a `createXxxTool(options)` factory returning a `ToolDefinition`
 *     (tools that need wired runtime dependencies).
 *
 * `buildBuiltinTools(options)` instantiates every built-in for a tool host.
 * The host then drops these into a single `Map<name, ToolDefinition>`
 * that drives both the catalog the model sees AND the handler dispatcher.
 *
 * No central description/schema map. No name-string lookup with a placeholder
 * fallback. If a tool isn't in the registry, the agent loop never sees it.
 */

import type { ShellState } from "../shell.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolHostOptions,
  ToolResult,
  ToolUpdateCallback,
} from "../types.js";

import { applyPatchTool } from "./apply-patch.js";
import { askQuestionTool } from "./ask-question.js";
import { askUserQuestionTool } from "./ask-user-question.js";
import { createComputerTools } from "./computer.js";
import { createDisplayTools } from "./display.js";
import { dreamTool } from "./dream.js";
import { createExecCommandTool } from "./exec-command.js";
import { createFashionControlTools } from "./fashion-control.js";
import { grepTool } from "./grep.js";
import { createImageGenTool } from "./image-gen.js";
import { createMemoryTool } from "./memory.js";
import { createMultiToolUseParallelTool } from "./multi-tool-use-parallel.js";
import { readTool } from "./read.js";
import { createRequestCredentialTool } from "./request-credential.js";
import { createScheduleTool } from "./schedule.js";
import { createScheduleControlTools } from "./schedule-control.js";
import { createStoreTool } from "./store.js";
import { createStoreControlTools } from "./store-control.js";
import { strReplaceTool } from "./str-replace.js";
import { createAgentTools } from "./task.js";
import { viewImageTool } from "./view-image.js";
import { createWebTool } from "./web.js";
import { createWriteStdinTool } from "./write-stdin.js";

import type { StateContext } from "../state.js";

export type BuildBuiltinToolsContext = ToolHostOptions & {
  /** Initialized PTY shell state shared by exec_command / write_stdin. */
  shellState: ShellState;
  /** Initialized state context for the durable spawn_agent / send_input / pause_agent tools. */
  stateContext: StateContext;
  /**
   * Re-entrant tool dispatcher used by `multi_tool_use_parallel` to invoke
   * sibling tools. Provided by the host since the parallel tool needs a
   * reference to the same dispatcher it lives behind.
   */
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
};

/**
 * Construct every built-in tool for a host. The returned array order doesn't
 * matter — the host indexes them by name.
 */
export const buildBuiltinTools = (
  options: BuildBuiltinToolsContext,
): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];

  // General-agent surface
  tools.push(createExecCommandTool(options.shellState));
  tools.push(createWriteStdinTool(options.shellState));
  tools.push(applyPatchTool);
  tools.push(viewImageTool);
  tools.push(createImageGenTool({
    getStellaSiteAuth: options.getStellaSiteAuth,
    queryConvex: options.queryConvex,
  }));
  tools.push(createMultiToolUseParallelTool({
    executeTool: options.executeTool,
  }));
  tools.push(createRequestCredentialTool({
    requestCredential: options.requestCredential,
  }));
  tools.push(createWebTool({ webSearch: options.webSearch }));

  // macOS computer-use surface (9 sibling tools sharing one CLI wrapper).
  tools.push(
    ...createComputerTools({
      stellaComputerCliPath: options.stellaComputerCliPath,
    }),
  );

  // Orchestrator coordination surface
  tools.push(...createDisplayTools({ displayHtml: options.displayHtml }));
  tools.push(askQuestionTool);
  tools.push(askUserQuestionTool);
  tools.push(
    createScheduleTool({
      agentApi: options.agentApi,
      scheduleApi: options.scheduleApi,
    }),
  );
  tools.push(createStoreTool({ agentApi: options.agentApi }));
  tools.push(...createAgentTools(options.stateContext));
  if (options.memoryStore) {
    tools.push(createMemoryTool({ memoryStore: options.memoryStore }));
  }

  // Schedule subagent surface
  tools.push(
    ...createScheduleControlTools({ scheduleApi: options.scheduleApi }),
  );

  // Store subagent surface
  tools.push(...createStoreControlTools({ storeApi: options.storeApi }));

  // Fashion subagent surface
  tools.push(...createFashionControlTools({ fashionApi: options.fashionApi }));

  // Subagent file/search/dream surface
  // Read & Grep have unrestricted handlers in the host; StrReplace and Dream
  // are intercepted by `dispatchLocalTool` inside the Dream subagent and
  // simply error out from the host path.
  tools.push(readTool);
  tools.push(grepTool);
  tools.push(strReplaceTool);
  tools.push(dreamTool);

  return tools;
};
