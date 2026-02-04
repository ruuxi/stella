import { tool, ToolSet } from "ai";
import type { ActionCtx } from "../_generated/server";
import {
  createCoreDeviceTools,
  executeDeviceTool,
  sanitizeToolName,
  type DeviceToolContext,
} from "../device_tools";
import { jsonSchemaToZod } from "../plugins";
import { createBackendTools } from "./backend";
import { createOrchestrationTools } from "./orchestration";
import { BASE_TOOL_NAMES, type PluginToolDescriptor, type ToolOptions } from "./types";

export { BASE_TOOL_NAMES, type PluginToolDescriptor, type ToolOptions } from "./types";
export type { DeviceToolContext } from "../device_tools";

const filterTools = (
  tools: ToolSet,
  allowlist?: string[],
): ToolSet => {
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }
  const allowed = new Set(allowlist);
  const filteredEntries = Object.entries(tools).filter(([name]) => allowed.has(name));
  return Object.fromEntries(filteredEntries) as ToolSet;
};

export const createTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
): ToolSet => {
  const coreTools = createCoreDeviceTools(ctx, context);
  const backendTools = createBackendTools(ctx, options);
  const orchestrationTools = createOrchestrationTools(ctx, context, options);

  // Build plugin tools dynamically from descriptors
  const pluginToolEntries = options.pluginTools.map((descriptor) => {
    // Sanitize tool name for AI provider compatibility (no dots allowed)
    const sanitizedName = sanitizeToolName(descriptor.name);
    return [
      sanitizedName,
      tool({
        description: descriptor.description,
        inputSchema: jsonSchemaToZod(descriptor.inputSchema),
        // Use original name for device dispatch
        execute: (args) => executeDeviceTool(ctx, context, descriptor.name, args),
      }),
    ] as const;
  });
  const pluginTools = Object.fromEntries(pluginToolEntries);

  const allTools: ToolSet = {
    ...coreTools,
    ...backendTools,
    ...pluginTools,
    ...orchestrationTools,
  };

  const allowlist = options.toolsAllowlist
    ? Array.from(
        new Set([
          // Sanitize allowlist entries and always include Task/TaskOutput/AgentInvoke
          ...options.toolsAllowlist.map(sanitizeToolName),
          "Task",
          "TaskOutput",
          "AgentInvoke",
          "ActivateSkill",
          ...options.pluginTools.map((toolDef) => sanitizeToolName(toolDef.name)),
        ]),
      )
    : undefined;
  return filterTools(allTools, allowlist);
};
