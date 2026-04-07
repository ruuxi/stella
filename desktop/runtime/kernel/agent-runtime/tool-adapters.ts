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
import {
  getDynamicToolDescription,
  getDynamicToolSchema,
} from "../tools/dynamic-tool-metadata-registry.js";

const STELLA_LOCAL_TOOLS = [
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

export const createPiTools = (opts: {
  runId: string;
  rootRunId?: string;
  taskId?: string;
  conversationId: string;
  agentType: string;
  deviceId: string;
  stellaHome: string;
  frontendRoot?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  toolsAllowlist?: string[];
  toolCatalog?: ToolMetadata[];
  defaultSkills?: string[];
  skillIds?: string[];
  store: RuntimeStore;
  loadTools?: (args: {
    taskId?: string;
    prompt: string;
    loadedToolNames: string[];
  }) => Promise<{ addedTools: string[]; currentTools: string[] }>;
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
  const requested =
    Array.isArray(opts.toolsAllowlist) && opts.toolsAllowlist.length > 0
      ? opts.toolsAllowlist
      : [...STELLA_LOCAL_TOOLS];

  const toolMetadata = new Map<string, ToolMetadata>(
    (opts.toolCatalog ?? []).map((tool) => [tool.name, tool]),
  );
  const activeTools: AgentTool[] = [];
  const activeToolNames = new Set<string>();

  const getToolMetadata = (toolName: string): ToolMetadata => ({
    name: toolName,
    description:
      toolMetadata.get(toolName)?.description ??
      TOOL_DESCRIPTIONS[toolName] ??
      getDynamicToolDescription(toolName) ??
      `${toolName} tool`,
    parameters:
      toolMetadata.get(toolName)?.parameters ??
      ((TOOL_JSON_SCHEMAS[toolName] ??
        getDynamicToolSchema(toolName) ??
        AnyToolArgsSchema) as Record<string, unknown>),
  });

  const buildContext = (toolCallId: string): ToolContext => ({
    conversationId: opts.conversationId,
    deviceId: opts.deviceId,
    requestId: toolCallId,
    runId: opts.runId,
    ...(opts.rootRunId ? { rootRunId: opts.rootRunId } : {}),
    agentType: opts.agentType,
    ...(opts.frontendRoot ? { frontendRoot: opts.frontendRoot } : {}),
    storageMode: "local",
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(typeof opts.taskDepth === "number"
      ? { taskDepth: opts.taskDepth }
      : {}),
    ...(typeof opts.maxTaskDepth === "number"
      ? { maxTaskDepth: opts.maxTaskDepth }
      : {}),
    ...(opts.defaultSkills ? { defaultSkills: opts.defaultSkills } : {}),
    ...(opts.skillIds ? { skillIds: opts.skillIds } : {}),
  });

  const registerTool = (toolName: string): AgentTool => {
    const metadata = getToolMetadata(toolName);
    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: metadata.description,
      parameters: metadata.parameters as typeof AnyToolArgsSchema,
      execute: async (toolCallId, params, signal) => {
        const args = (params as Record<string, unknown>) ?? {};

        const localResult = await dispatchLocalTool(toolName, args, {
          conversationId: opts.conversationId,
          webSearch: opts.webSearch,
          store: opts.store,
        });
        if (localResult.handled) {
          return {
            content: [{ type: "text", text: localResult.text }],
            details: { text: localResult.text },
          };
        }

        const context = buildContext(toolCallId);
        let effectiveArgs = args;
        if (opts.hookEmitter) {
          const hookResult = await opts.hookEmitter.emit(
            "before_tool",
            { tool: toolName, args, context },
            { tool: toolName, agentType: opts.agentType },
          );
          if (hookResult?.cancel) {
            return {
              content: [
                {
                  type: "text",
                  text: `Tool blocked: ${hookResult.reason ?? "blocked by hook"}`,
                },
              ],
              details: { blocked: true },
            };
          }
          if (hookResult?.args) {
            effectiveArgs = hookResult.args;
          }
        }

        let toolResult = await opts.toolExecutor(
          toolName,
          effectiveArgs,
          context,
          signal,
        );

        if (opts.hookEmitter) {
          const hookResult = await opts.hookEmitter.emit(
            "after_tool",
            { tool: toolName, args: effectiveArgs, result: toolResult, context },
            { tool: toolName, agentType: opts.agentType },
          );
          if (hookResult?.result) {
            toolResult = hookResult.result;
          }
        }

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
