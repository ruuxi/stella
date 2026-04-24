import type { ActionCtx } from "../_generated/server";
import { TRANSIENT_ALLOWED_BACKEND_TOOL_NAMES } from "../lib/agent_constants";
import { createBackendTools } from "./backend";
import { type BackendToolSet, type ToolOptions } from "./types";

export { BASE_TOOL_NAMES, type ToolOptions } from "./types";

const filterTools = (tools: BackendToolSet, allowlist?: string[]): BackendToolSet => {
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }
  const allowed = new Set(allowlist);
  const filteredEntries = Object.entries(tools).filter(([name]) =>
    allowed.has(name),
  );
  return Object.fromEntries(filteredEntries) as BackendToolSet;
};

const TRANSIENT_ALLOWED_TOOLS = new Set<string>(TRANSIENT_ALLOWED_BACKEND_TOOL_NAMES);

const sanitizeToolName = (name: string): string => name.replace(/\./g, "_");

export const createTools = (ctx: ActionCtx, options: ToolOptions): BackendToolSet => {
  const allTools: BackendToolSet = createBackendTools(ctx, options);

  const privacyFilteredTools = options.transient
    ? (Object.fromEntries(
        Object.entries(allTools).filter(([name]) =>
          TRANSIENT_ALLOWED_TOOLS.has(name),
        ),
      ) as BackendToolSet)
    : allTools;

  const allowlist = options.toolsAllowlist
    ? Array.from(new Set([...options.toolsAllowlist.map(sanitizeToolName)]))
    : undefined;
  return filterTools(privacyFilteredTools, allowlist);
};
