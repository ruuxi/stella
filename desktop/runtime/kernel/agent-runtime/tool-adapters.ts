import type { AgentTool } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import {
  DEVICE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_JSON_SCHEMAS,
} from "../tools/schemas.js";
import type { ToolContext, ToolMetadata, ToolResult } from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { TOOL_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { AnyToolArgsSchema, textFromUnknown } from "./shared.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";

export const STELLA_LOCAL_TOOLS = [
  ...DEVICE_TOOL_NAMES,
  "TaskUpdate",
  "TaskCreate",
  "TaskPause",
  "TaskOutput",
  TOOL_IDS.WEB_FETCH,
  TOOL_IDS.NO_RESPONSE,
  TOOL_IDS.SAVE_MEMORY,
  TOOL_IDS.RECALL_MEMORIES,
] as const;

const getToolMetadataIndex = (toolCatalog?: ToolMetadata[]) =>
  new Map<string, ToolMetadata>(
    (toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );

const resolveToolMetadata = (
  toolName: string,
  toolMetadata: Map<string, ToolMetadata>,
): ToolMetadata => ({
  name: toolName,
  description:
    toolMetadata.get(toolName)?.description ??
    TOOL_DESCRIPTIONS[toolName] ??
    `${toolName} tool`,
  parameters:
    toolMetadata.get(toolName)?.parameters ??
    ((TOOL_JSON_SCHEMAS[toolName] ?? AnyToolArgsSchema) as Record<string, unknown>),
});

export const getRequestedRuntimeToolNames = (
  toolsAllowlist?: string[],
): string[] =>
  Array.isArray(toolsAllowlist) && toolsAllowlist.length > 0
    ? toolsAllowlist
    : [...STELLA_LOCAL_TOOLS];

export const getRuntimeToolMetadata = (opts: {
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
}): ToolMetadata[] => {
  const toolMetadata = getToolMetadataIndex(opts.toolCatalog);
  const resolved: ToolMetadata[] = [];
  const seen = new Set<string>();
  for (const toolName of getRequestedRuntimeToolNames(opts.toolsAllowlist)) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    resolved.push(resolveToolMetadata(toolName, toolMetadata));
  }
  return resolved;
};

const formatToolResult = (
  toolResult: ToolResult,
): { text: string; details: unknown } => {
  if (toolResult.error) {
    return {
      text: `Error: ${toolResult.error}`,
      details: { error: toolResult.error },
    };
  }

  return {
    text: textFromUnknown(toolResult.result),
    details: toolResult.details ?? toolResult.result,
  };
};

type RuntimeToolContextArgs = {
  toolCallId: string;
  runId: string;
  rootRunId?: string;
  taskId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  frontendRoot?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
};

export const buildRuntimeToolContext = (
  args: RuntimeToolContextArgs,
): ToolContext => ({
  conversationId: args.conversationId,
  deviceId: args.deviceId,
  requestId: args.toolCallId,
  runId: args.runId,
  ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
  agentType: args.agentType,
  ...(args.frontendRoot ? { frontendRoot: args.frontendRoot } : {}),
  storageMode: "local",
  ...(args.taskId ? { taskId: args.taskId } : {}),
  ...(typeof args.taskDepth === "number" ? { taskDepth: args.taskDepth } : {}),
  ...(typeof args.maxTaskDepth === "number"
    ? { maxTaskDepth: args.maxTaskDepth }
    : {}),
});

type RuntimeToolExecutionArgs = RuntimeToolContextArgs & {
  toolName: string;
  args: Record<string, unknown>;
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  hookEmitter?: HookEmitter;
  signal?: AbortSignal;
};

export const executeRuntimeToolCall = async (
  args: RuntimeToolExecutionArgs,
): Promise<ToolResult> => {
  const localResult = await dispatchLocalTool(args.toolName, args.args, {
    conversationId: args.conversationId,
    webSearch: args.webSearch,
    store: args.store,
  });
  if (localResult.handled) {
    return {
      result: localResult.text,
      details: { text: localResult.text },
    };
  }

  const context = buildRuntimeToolContext(args);
  let effectiveArgs = args.args;
  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "before_tool",
      { tool: args.toolName, args: args.args, context },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.cancel) {
      return {
        error: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
      };
    }
    if (hookResult?.args) {
      effectiveArgs = hookResult.args;
    }
  }

  let toolResult = await args.toolExecutor(
    args.toolName,
    effectiveArgs,
    context,
    args.signal,
  );

  if (args.hookEmitter) {
    const hookResult = await args.hookEmitter.emit(
      "after_tool",
      {
        tool: args.toolName,
        args: effectiveArgs,
        result: toolResult,
        context,
      },
      { tool: args.toolName, agentType: args.agentType },
    );
    if (hookResult?.result) {
      toolResult = hookResult.result;
    }
  }

  return toolResult;
};

export const createPiTools = (opts: {
  runId: string;
  rootRunId?: string;
  taskId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  frontendRoot?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  store: RuntimeStore;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  webSearch?: (
    query: string,
    options?: {
      category?: string;
    },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  hookEmitter?: HookEmitter;
}): AgentTool[] => {
  const requested = getRequestedRuntimeToolNames(opts.toolsAllowlist);
  const toolMetadata = getToolMetadataIndex(opts.toolCatalog);
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();

  const registerTool = (toolName: string): AgentTool => {
    const metadata = resolveToolMetadata(toolName, toolMetadata);
    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      execute: async (toolCallId, params, signal) => {
        const args = (params as Record<string, unknown>) ?? {};
        const toolResult = await executeRuntimeToolCall({
          toolCallId,
          toolName,
          args,
          runId: opts.runId,
          rootRunId: opts.rootRunId,
          taskId: opts.taskId,
          conversationId: opts.conversationId,
          agentType: opts.agentType,
          deviceId: opts.deviceId,
          frontendRoot: opts.frontendRoot,
          taskDepth: opts.taskDepth,
          maxTaskDepth: opts.maxTaskDepth,
          store: opts.store,
          toolExecutor: opts.toolExecutor,
          webSearch: opts.webSearch,
          hookEmitter: opts.hookEmitter,
          signal,
        });
        const formatted = formatToolResult(toolResult);
        return {
          content: [{ type: "text", text: formatted.text }],
          details: formatted.details,
        };
      },
    };
    return tool;
  };

  for (const toolName of requested) {
    if (activeToolNames.has(toolName)) continue;
    activeToolNames.add(toolName);
    activeTools.push(registerTool(toolName));
  }

  return activeTools;
};
