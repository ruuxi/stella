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
import { createCloudTools } from "./cloud";
import { createOrchestrationTools, createOrchestrationToolsWithoutDevice } from "./orchestration";
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
  context: DeviceToolContext | undefined,
  options: ToolOptions & { spriteName?: string },
): ToolSet => {
  // Tier 2: Local device tools (if Electron app running)
  const coreTools = context ? createCoreDeviceTools(ctx, context) : {};

  // Tier 1: Cloud tools (if 24/7 mode enabled and no local device)
  const cloudTools = !context && options.spriteName
    ? createCloudTools(options.spriteName)
    : {};

  // Tier 0: Backend tools (always available)
  const backendTools = createBackendTools(ctx, options);

  // Orchestration tools (MemorySearch always works; Task/AgentInvoke need device context)
  const orchestrationTools = context
    ? createOrchestrationTools(ctx, context, options)
    : createOrchestrationToolsWithoutDevice(ctx, options);

  // Build plugin tools dynamically from descriptors (require device context)
  const pluginTools = context
    ? Object.fromEntries(
        options.pluginTools.map((descriptor) => {
          const sanitizedName = sanitizeToolName(descriptor.name);
          return [
            sanitizedName,
            tool({
              description: descriptor.description,
              inputSchema: jsonSchemaToZod(descriptor.inputSchema),
              execute: (args) => executeDeviceTool(ctx, context, descriptor.name, args),
            }),
          ] as const;
        }),
      )
    : {};

  const allTools: ToolSet = {
    ...coreTools,
    ...cloudTools,
    ...backendTools,
    ...pluginTools,
    ...orchestrationTools,
  };

  const allowlist = options.toolsAllowlist
    ? Array.from(
        new Set([
          // Sanitize allowlist entries and always include Task/AgentInvoke
          ...options.toolsAllowlist.map(sanitizeToolName),
          "Task",
          "AgentInvoke",
          "ActivateSkill",
          ...options.pluginTools.map((toolDef) => sanitizeToolName(toolDef.name)),
        ]),
      )
    : undefined;
  return filterTools(allTools, allowlist);
};
