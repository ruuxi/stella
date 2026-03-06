import { ToolSet } from "ai";
import type { ActionCtx } from "../_generated/server";
import {
  sanitizeToolName,
} from "../agent/device_tools";
import { createBackendTools } from "./backend";
import { type ToolOptions } from "./types";

export { BASE_TOOL_NAMES, type ToolOptions } from "./types";

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
  "ListResources",
  "NoResponse",
]);

export const createTools = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  const backendTools = createBackendTools(ctx, options);
  const orchestrationTools = createOrchestrationTools(ctx, options);

  const allTools: ToolSet = {
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
