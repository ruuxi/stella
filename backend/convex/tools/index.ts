import { ToolSet } from "ai";
import type { ActionCtx } from "../_generated/server";
import {
  createCoreDeviceTools,
  sanitizeToolName,
  type DeviceToolContext,
} from "../agent/device_tools";
import { createBackendTools } from "./backend";
import { createCloudTools } from "./cloud";
import { createOrchestrationTools, createOrchestrationToolsWithoutDevice } from "./orchestration";
import { type ToolOptions } from "./types";

export { BASE_TOOL_NAMES, type ToolOptions } from "./types";
export type { DeviceToolContext } from "../agent/device_tools";

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

// Privacy-preserving tool subset for transient runs (sync off):
// avoid local device transport/persistence risk by limiting to backend read-only tools.
const TRANSIENT_ALLOWED_TOOLS = new Set<string>([
  "WebSearch",
  "WebFetch",
  "StoreSearch",
  "ListResources",
  "NoResponse",
]);

export const createTools = (
  ctx: ActionCtx,
  context: DeviceToolContext | undefined,
  options: ToolOptions,
): ToolSet => {
  // Tier 2: Local device tools (if Electron app running)
  const coreTools = context ? createCoreDeviceTools(ctx, context) : {};

  // Tier 1: Cloud tools (if 24/7 mode enabled and no local device)
  const cloudTools = !context && options.spriteName && options.ownerId
    ? createCloudTools(ctx, options.ownerId, options.spriteName)
    : {};

  // Tier 0: Backend tools (always available)
  const backendTools = createBackendTools(ctx, options);

  // Orchestration tools (memory tools always work; Task tools need device context)
  const orchestrationTools = context
    ? createOrchestrationTools(ctx, context, options)
    : createOrchestrationToolsWithoutDevice(ctx, options);

  const allTools: ToolSet = {
    ...coreTools,
    ...cloudTools,
    ...backendTools,
    ...orchestrationTools,
  };

  const privacyFilteredTools =
    options.transient
      ? (Object.fromEntries(
        Object.entries(allTools).filter(([name]) => TRANSIENT_ALLOWED_TOOLS.has(name)),
      ) as ToolSet)
      : allTools;

  const allowlist = options.toolsAllowlist
      ? Array.from(
        new Set([
          ...options.toolsAllowlist.map(sanitizeToolName),
        ]),
      )
    : undefined;
  return filterTools(privacyFilteredTools, allowlist);
};
